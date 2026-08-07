/**
 * The real execution plane: `SandboxManager` backed by E2B.
 *
 * This is the only module in the repo allowed to know that E2B exists — the dependency
 * rule in docs/PLAN.md §0 is enforced by a test, so swapping providers stays a change to
 * one file rather than a search across the codebase.
 *
 * Two places where E2B's contract and ours genuinely disagree, and this adapter is
 * where that disagreement gets resolved:
 *
 *  - **A failing command is data to us, an exception to E2B.** `commands.run` throws
 *    `CommandExitError` for any non-zero exit. If that propagated, a failing test suite
 *    or a type error in the user's project would reach the agent as an infrastructure
 *    fault instead of as output it should read and act on.
 *  - **E2B cannot tell a killed sandbox from one that never existed** — both surface as
 *    `SandboxNotFoundError`. Our contract separates them, because using a sandbox you
 *    already tore down is a different bug from using a bad id. So the adapter remembers
 *    which ids it killed.
 *
 * The SDK is reached through a small injected `E2BClient` rather than by calling
 * `Sandbox` directly, so error-mapping tests can drive every failure path with a stub
 * and no network.
 */

import type {
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox as NapSandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";
import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  FileType,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";

/** The slice of an E2B sandbox this adapter uses. Narrow on purpose: it is what a stub must fake. */
export type E2BSandboxHandle = {
  sandboxId: string;
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
    list(path: string, opts?: { depth?: number }): Promise<E2BEntry[]>;
  };
  commands: {
    run(
      cmd: string,
      opts?: { onStdout?: (data: string) => void; onStderr?: (data: string) => void },
    ): Promise<E2BCommandResult>;
  };
  getHost(port: number): string;
  /** Reads back what `create` stored, which is how a resume recovers the project id. */
  getMetadata(): Promise<Record<string, string>>;
  kill(): Promise<boolean>;
};

/** `EntryInfo`, minus the fields we ignore. `type` is optional in the SDK. */
export type E2BEntry = { name: string; path: string; type?: FileType };

export type E2BCommandResult = { exitCode: number; stdout: string; stderr: string };

export type E2BClient = {
  create(opts: { metadata: Record<string, string> }): Promise<E2BSandboxHandle>;
  connect(sandboxId: string): Promise<E2BSandboxHandle>;
};

export type E2BSandboxManagerOptions = {
  /** Defaults to the real SDK. Tests pass a stub. */
  client?: E2BClient;
  /** Template to create sandboxes from; the project template arrives in a later task. */
  template?: string;
};

/** Where the metadata key lives, so create and resume cannot drift apart. */
const PROJECT_ID_KEY = "projectId";

/**
 * Translates an SDK failure into our error vocabulary.
 *
 * Exported because it is the part most likely to be wrong and the part cheapest to test
 * directly. Note `AuthenticationError` extends `Error`, not `SandboxError`, so an
 * `instanceof SandboxError` catch-all would silently miss a bad API key.
 */
export function toSandboxError(cause: unknown): SandboxError {
  const message = cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof FileNotFoundError) return { code: "file_not_found", message };
  if (cause instanceof SandboxNotFoundError) return { code: "not_found", message };
  if (cause instanceof TimeoutError) return { code: "timeout", message };
  if (cause instanceof AuthenticationError) return { code: "unavailable", message };

  // Everything else — rate limits, a full disk, a dropped connection — is the sandbox
  // being unusable right now. The message carries the specifics to the log.
  return { code: "unavailable", message };
}

function toFileNode(entry: E2BEntry): FileNode {
  // `type` is optional in the SDK, and our contract has no third kind: a symlink is
  // readable, so it presents as a file rather than vanishing from the listing.
  return { path: entry.path, type: entry.type === FileType.DIR ? "directory" : "file" };
}

/** Wraps the real `Sandbox` class in the narrow shape above. */
function realClient(template: string | undefined): E2BClient {
  const adapt = (sandbox: Sandbox): E2BSandboxHandle => ({
    sandboxId: sandbox.sandboxId,
    files: {
      read: (path) => sandbox.files.read(path),
      write: (path, data) => sandbox.files.write(path, data),
      list: (path, opts) => sandbox.files.list(path, opts),
    },
    commands: {
      run: (cmd, opts) => sandbox.commands.run(cmd, { ...opts, background: false }),
    },
    getHost: (port) => sandbox.getHost(port),
    getMetadata: async () => (await sandbox.getInfo()).metadata,
    kill: () => sandbox.kill(),
  });

  return {
    create: async (opts) =>
      adapt(
        template === undefined ? await Sandbox.create(opts) : await Sandbox.create(template, opts),
      ),
    connect: async (sandboxId) => adapt(await Sandbox.connect(sandboxId)),
  };
}

export class E2BSandboxManager implements SandboxManager {
  readonly #client: E2BClient;
  /** Ids this manager killed, so a use-after-destroy is distinguishable from a bad id. */
  readonly #destroyed = new Set<string>();
  /**
   * Live handles, keyed by sandbox id. Connecting is a network round-trip and a single
   * agent turn does dozens of file operations, so without this there would be an API
   * call between every one of them.
   */
  readonly #handles = new Map<string, E2BSandboxHandle>();

  constructor(options: E2BSandboxManagerOptions = {}) {
    this.#client = options.client ?? realClient(options.template);
  }

  async create(projectId: string): Promise<Result<NapSandbox, SandboxError>> {
    try {
      // Stored on the sandbox rather than only in this process, so a resume in a later
      // process can still say which project the sandbox belongs to.
      const handle = await this.#client.create({ metadata: { [PROJECT_ID_KEY]: projectId } });
      this.#handles.set(handle.sandboxId, handle);
      return { ok: true, value: { id: handle.sandboxId, projectId } };
    } catch (cause) {
      return { ok: false, error: toSandboxError(cause) };
    }
  }

  async resume(sandboxId: string): Promise<Result<NapSandbox, SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;

    try {
      const handle = await this.#handle(sandboxId);
      const metadata = await handle.getMetadata();
      return {
        ok: true,
        value: { id: handle.sandboxId, projectId: metadata[PROJECT_ID_KEY] ?? "" },
      };
    } catch (cause) {
      return { ok: false, error: toSandboxError(cause) };
    }
  }

  async destroy(sandboxId: string): Promise<VoidResult<SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;

    try {
      const handle = await this.#handle(sandboxId);
      await handle.kill();
      this.#handles.delete(sandboxId);
      this.#destroyed.add(sandboxId);
      return { ok: true, value: undefined };
    } catch (cause) {
      return { ok: false, error: toSandboxError(cause) };
    }
  }

  async writeFile(
    sandboxId: string,
    path: string,
    contents: string,
  ): Promise<VoidResult<SandboxError>> {
    return this.#withSandbox(sandboxId, async (handle) => {
      await handle.files.write(path, contents);
      return undefined;
    });
  }

  async readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>> {
    return this.#withSandbox(sandboxId, (handle) => handle.files.read(path));
  }

  async listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    return this.#withSandbox(sandboxId, async (handle) => {
      // Depth 1 is direct children, matching what the contract specifies and what the
      // in-memory implementation does.
      const entries = await handle.files.list(path, { depth: 1 });
      return entries.map(toFileNode);
    });
  }

  async exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
  ): Promise<Result<ExecResult, SandboxError>> {
    return this.#withSandbox(sandboxId, async (handle) => {
      try {
        const result = await handle.commands.run(command, {
          onStdout: (data) => onOutput?.({ stream: "stdout", data }),
          onStderr: (data) => onOutput?.({ stream: "stderr", data }),
        });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (cause) {
        // A non-zero exit is an outcome, not a fault — see the module doc.
        if (cause instanceof CommandExitError) {
          return { exitCode: cause.exitCode, stdout: cause.stdout, stderr: cause.stderr };
        }
        throw cause;
      }
    });
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<Result<string, SandboxError>> {
    return this.#withSandbox(sandboxId, (handle) =>
      // getHost returns a bare host with no scheme; a caller handed that to fetch or to
      // a browser would resolve it as a relative path.
      Promise.resolve(`https://${handle.getHost(port)}`),
    );
  }

  /** Connects, runs `body`, and funnels every failure through one mapping. */
  async #withSandbox<T>(
    sandboxId: string,
    body: (handle: E2BSandboxHandle) => Promise<T>,
  ): Promise<Result<T, SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;

    try {
      return { ok: true, value: await body(await this.#handle(sandboxId)) };
    } catch (cause) {
      return { ok: false, error: toSandboxError(cause) };
    }
  }

  async #handle(sandboxId: string): Promise<E2BSandboxHandle> {
    const cached = this.#handles.get(sandboxId);
    if (cached !== undefined) return cached;

    const handle = await this.#client.connect(sandboxId);
    this.#handles.set(sandboxId, handle);
    return handle;
  }

  #tombstone(sandboxId: string): { ok: false; error: SandboxError } | undefined {
    if (!this.#destroyed.has(sandboxId)) return undefined;
    return {
      ok: false,
      error: { code: "destroyed", message: `sandbox ${sandboxId} was destroyed` },
    };
  }
}
