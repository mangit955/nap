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

import type { SandboxInventory, SandboxListing } from "@nap/shared/ports/sandbox-inventory";
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
  /** Resets the sandbox's lifetime to `ms` from now. */
  setTimeout(ms: number): Promise<void>;
  kill(): Promise<boolean>;
};

/** `EntryInfo`, minus the fields we ignore. `type` is optional in the SDK. */
export type E2BEntry = { name: string; path: string; type?: FileType };

export type E2BCommandResult = { exitCode: number; stdout: string; stderr: string };

/** One running sandbox as the provider describes it. `SandboxInfo`, minus the fields we ignore. */
export type E2BSandboxSummary = {
  sandboxId: string;
  metadata: Record<string, string>;
  startedAt: Date;
};

export type E2BClient = {
  create(opts: { metadata: Record<string, string>; timeoutMs?: number }): Promise<E2BSandboxHandle>;
  connect(sandboxId: string): Promise<E2BSandboxHandle>;
  /**
   * Every sandbox running on this account, every page of it.
   *
   * Pagination is resolved here rather than handed upwards: the caller is asking what exists,
   * and an answer that stopped at the first hundred would quietly under-report exactly when the
   * account has the most to reconcile.
   */
  list(): Promise<E2BSandboxSummary[]>;
  /**
   * The cheapest authenticated round trip the API offers, for a reachability check.
   *
   * Listing rather than creating: a health check that created a sandbox would bill for every
   * poll and take seconds to answer. Listing still proves the whole path — network, endpoint
   * and credentials — which is what "reachable" has to mean if the answer is to be worth
   * anything.
   */
  ping(): Promise<unknown>;
};

export type E2BSandboxManagerOptions = {
  /** Defaults to the real SDK. Tests pass a stub. */
  client?: E2BClient;
  /** Template to create sandboxes from; the project template arrives in a later task. */
  template?: string;
  /**
   * How long a new sandbox lives before E2B kills it, in milliseconds.
   *
   * Left unset, the SDK's own default applies — five minutes, measured from creation and
   * unaffected by anything happening inside. Whoever knows a project is in use is expected
   * to push the deadline back with `extendTimeout`; this is only the starting budget.
   */
  timeoutMs?: number;
};

/** Where the metadata key lives, so create and resume cannot drift apart. */
const PROJECT_ID_KEY = "projectId";

/** Generous enough for a cold dependency graph, short enough to fail a turn rather than hang it. */
const DEFAULT_PREVIEW_TIMEOUT_MS = 30_000;
/** Gap between readiness probes. */
const PREVIEW_POLL_MS = 250;
/** Ceiling on a single probe, so one stalled request cannot consume the whole budget. */
const PREVIEW_PROBE_TIMEOUT_MS = 5_000;

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
    setTimeout: (ms) => sandbox.setTimeout(ms),
    kill: () => sandbox.kill(),
  });

  return {
    create: async (opts) =>
      adapt(
        template === undefined ? await Sandbox.create(opts) : await Sandbox.create(template, opts),
      ),
    connect: async (sandboxId) => adapt(await Sandbox.connect(sandboxId)),
    // One page of one item. `list` returns a paginator that has made no request yet, so the
    // round trip only happens on `nextItems` — a probe that stopped at `Sandbox.list()` would
    // pass while the API was unreachable.
    ping: () => Sandbox.list({ limit: 1 }).nextItems(),
    list: async () => {
      // Running only. A paused sandbox is not what this is looking for — nothing in this system
      // pauses one — and destroying somebody else's paused work on the strength of "no project
      // row names it" is the one mistake here that cannot be undone.
      const paginator = Sandbox.list({ query: { state: ["running"] } });
      const sandboxes: E2BSandboxSummary[] = [];

      // `hasNext` starts true and only becomes false after a page has come back, so this always
      // makes at least one request.
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) {
          sandboxes.push({
            sandboxId: info.sandboxId,
            metadata: info.metadata,
            startedAt: info.startedAt,
          });
        }
      }

      return sandboxes;
    },
  };
}

export class E2BSandboxManager implements SandboxManager, SandboxInventory {
  readonly #client: E2BClient;
  readonly #timeoutMs: number | undefined;
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
    this.#timeoutMs = options.timeoutMs;
  }

  async create(projectId: string): Promise<Result<NapSandbox, SandboxError>> {
    try {
      // Stored on the sandbox rather than only in this process, so a resume in a later
      // process can still say which project the sandbox belongs to.
      const handle = await this.#client.create({
        metadata: { [PROJECT_ID_KEY]: projectId },
        ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
      });
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

  /**
   * `SandboxInventory`: what the provider says it is running, whoever asked for it.
   *
   * The only question in this file that is not about a sandbox somebody can already name, which
   * is exactly why it exists — a sandbox created just before the transaction recording it failed
   * is running and billed and named nowhere else. The project id comes back out of the metadata
   * `create` put there, and is null rather than empty when absent: something else made it, and a
   * caller that destroys what nothing references must be able to tell those apart.
   */
  async list(): Promise<Result<SandboxListing[], SandboxError>> {
    try {
      const sandboxes = await this.#client.list();
      return {
        ok: true,
        value: sandboxes.map((sandbox) => ({
          id: sandbox.sandboxId,
          projectId: sandbox.metadata[PROJECT_ID_KEY] ?? null,
          startedAt: sandbox.startedAt.toISOString(),
        })),
      };
    } catch (cause) {
      return { ok: false, error: toSandboxError(cause) };
    }
  }

  /**
   * Whether the provider is reachable at all, for a health check to report.
   *
   * Deliberately **not** on the `SandboxManager` interface. That port is about one project's
   * workspace — create it, write to it, run things in it — and every method takes a sandbox
   * id. "Is the provider up?" is a question about the deployment rather than about anybody's
   * project, and putting it on the port would oblige every implementation, including the
   * in-memory fake, to answer something meaningless. Boot holds the concrete class, which is
   * the only place that needs to ask.
   *
   * Rejects rather than returning a `Result`, because that is what a `HealthCheck` consumes
   * and there is nothing here a caller could branch on: the answer is yes or it is no.
   */
  async ping(): Promise<void> {
    await this.#client.ping();
  }

  async extendTimeout(sandboxId: string, ms: number): Promise<VoidResult<SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;

    try {
      const handle = await this.#handle(sandboxId);
      // Resets to `ms` from now rather than adding to what is left, which is what makes this
      // a keepalive: every turn puts the whole budget back.
      await handle.setTimeout(ms);
      return { ok: true, value: undefined };
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

  async waitForPreview(
    sandboxId: string,
    port: number,
    opts?: { timeoutMs?: number },
  ): Promise<Result<string, SandboxError>> {
    const url = await this.getPreviewUrl(sandboxId, port);
    if (!url.ok) return url;

    const deadline = Date.now() + (opts?.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS);
    let lastReason = "no response";

    while (Date.now() < deadline) {
      try {
        // Each attempt gets its own deadline so a request that hangs cannot swallow the
        // whole budget and turn a timeout into an indefinite wait.
        const response = await fetch(url.value, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(Math.min(PREVIEW_PROBE_TIMEOUT_MS, deadline - Date.now())),
        });
        if (response.ok) return { ok: true, value: url.value };
        lastReason = `HTTP ${response.status}`;
      } catch (cause) {
        // A refused connection is the normal state while a server is still booting, so
        // this is a retry rather than a failure.
        lastReason = cause instanceof Error ? cause.message : String(cause);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(PREVIEW_POLL_MS, remaining)));
    }

    return {
      ok: false,
      error: {
        code: "timeout",
        message: `preview at ${url.value} did not become ready (last: ${lastReason})`,
      },
    };
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
