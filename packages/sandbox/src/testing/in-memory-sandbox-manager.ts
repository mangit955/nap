/**
 * A `SandboxManager` that lives entirely in memory.
 *
 * Almost every test above the execution plane needs a sandbox but has no interest in
 * one: an agent-loop test cares that a file was written, not that a container existed.
 * This stands in for the real thing so those tests stay deterministic, free and fast.
 * It is held to the same contract as the E2B adapter by the conformance suite next to
 * this file, which both implementations run.
 *
 * The filesystem is a flat `Map` from absolute path to contents; directories are
 * inferred from the paths, so writing a nested file implicitly creates its parents.
 *
 * `exec` cannot be faked the same way — there is no shell here — so responses are
 * scripted per command. A command nobody scripted *throws*: a test running an
 * unscripted command is asserting against a response no one defined, and answering it
 * with a bland success would let that test pass while exercising nothing. Callers who
 * genuinely do not care pass `defaultExec`.
 */

import type { SandboxInventory, SandboxListing } from "@nap/shared/ports/sandbox-inventory";
import type {
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";

/** A scripted answer to one command. Every field has a sensible zero value. */
export type ScriptedExecResponse = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /**
   * Explicit streaming, when a test cares about interleaving. Omit it and one chunk
   * per non-empty stream is derived from `stdout`/`stderr`; supply it and the
   * aggregate `stdout`/`stderr` are the concatenation of these instead.
   */
  chunks?: ExecChunk[];
};

export type ExecChunk = { stream: "stdout" | "stderr"; data: string };

export type ExecResponder = (
  command: string,
) => ScriptedExecResponse | Promise<ScriptedExecResponse>;

export type InMemorySandboxManagerOptions = {
  /** Answers any command no `script()` call matched, in place of throwing. */
  defaultExec?: ExecResponder;
  /**
   * Ports every sandbox this manager creates is serving from the moment it exists.
   *
   * `listen()` cannot express that: a caller whose whole job is to create the sandbox has
   * nothing to call it on until after the fact, and by then whatever waited on the preview
   * has already given up. Left empty, nothing serves — which is how the "dev server never
   * came up" path is driven.
   */
  serves?: readonly number[];
  /**
   * Files every sandbox this manager creates already contains, by absolute path.
   *
   * A real sandbox comes up from a template with a project already in it, and code that reads
   * the project before writing to it — the verifier reads `package.json` to find out which
   * checks exist — sees an empty filesystem otherwise. As with `serves`, it has to be declared
   * up front: whoever calls `create` is usually the code under test, so nothing above it has
   * an id to write into until the run is over.
   */
  seed?: Readonly<Record<string, string>>;
  /**
   * The clock every sandbox's start time is read from. Injected so that "created an hour ago"
   * is a line in a test rather than an hour's wait — a reconciling sweep decides what to
   * destroy partly on how old a sandbox is.
   */
  now?: () => number;
};

type SandboxState = {
  projectId: string;
  files: Map<string, string>;
  commands: string[];
  /** Ports a test has declared to be serving; see `listen`. */
  listening: Set<number>;
  /** When `create` was called, as an ISO string, for the inventory to report. */
  startedAt: string;
  /** The lifetime last requested, recorded rather than enforced — nothing expires here. */
  timeoutMs: number | undefined;
};

/** Absolute POSIX paths with no trailing slash and no repeated separators. */
function normalize(path: string): string {
  const collapsed = path.replace(/\/+/g, "/").replace(/\/$/, "");
  return collapsed === "" ? "/" : collapsed;
}

function err(code: SandboxError["code"], message: string): { ok: false; error: SandboxError } {
  return { ok: false, error: { code, message } };
}

function toResponder(response: ScriptedExecResponse | ExecResponder): ExecResponder {
  return typeof response === "function" ? response : () => response;
}

export class InMemorySandboxManager implements SandboxManager, SandboxInventory {
  readonly #sandboxes = new Map<string, SandboxState>();
  /** Ids this manager destroyed, kept so a use-after-destroy reads differently from a typo. */
  readonly #destroyed = new Set<string>();
  readonly #exactScripts = new Map<string, ExecResponder>();
  readonly #patternScripts: Array<{ pattern: RegExp; responder: ExecResponder }> = [];
  readonly #defaultExec: ExecResponder | undefined;
  readonly #serves: readonly number[];
  readonly #seed: Readonly<Record<string, string>>;
  readonly #now: () => number;

  constructor(options: InMemorySandboxManagerOptions = {}) {
    this.#defaultExec = options.defaultExec;
    this.#serves = options.serves ?? [];
    this.#seed = options.seed ?? {};
    this.#now = options.now ?? Date.now;
  }

  /**
   * Registers the answer to a command. An exact string beats a regular expression that
   * also matches, and a later registration replaces an earlier one, so a test can set
   * up broad defaults once and override a single command per case.
   */
  script(matcher: string | RegExp, response: ScriptedExecResponse | ExecResponder): this {
    if (typeof matcher === "string") {
      this.#exactScripts.set(matcher, toResponder(response));
    } else {
      this.#patternScripts.push({ pattern: matcher, responder: toResponder(response) });
    }
    return this;
  }

  /**
   * Declares that something is serving `port`, which is what makes `waitForPreview`
   * resolve. There is no process here to bind anything, so readiness has to be stated
   * rather than observed — and being able to *not* state it is the point: it is how a
   * test drives the "dev server never came up" path without waiting on a real timeout.
   */
  listen(sandboxId: string, port: number): this {
    this.#sandboxes.get(sandboxId)?.listening.add(port);
    return this;
  }

  /** Every command `exec` was asked to run on a sandbox, in order. */
  commands(sandboxId: string): string[] {
    return [...(this.#sandboxes.get(sandboxId)?.commands ?? [])];
  }

  async create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    const id = crypto.randomUUID();
    this.#sandboxes.set(id, {
      projectId,
      files: new Map(
        Object.entries(this.#seed).map(([path, contents]) => [normalize(path), contents]),
      ),
      commands: [],
      listening: new Set(this.#serves),
      timeoutMs: undefined,
      startedAt: new Date(this.#now()).toISOString(),
    });
    return { ok: true, value: { id, projectId } };
  }

  /**
   * `SandboxInventory`: everything this manager currently holds.
   *
   * Implemented here as well as on the E2B adapter because the callers that reconcile capacity
   * against the provider have to be testable without one, and because a sandbox created through
   * `create` and then lost track of is exactly the situation they exist to clean up.
   */
  async list(): Promise<Result<SandboxListing[], SandboxError>> {
    return {
      ok: true,
      value: [...this.#sandboxes].map(([id, state]) => ({
        id,
        projectId: state.projectId,
        startedAt: state.startedAt,
      })),
    };
  }

  async resume(sandboxId: string): Promise<Result<Sandbox, SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;
    return { ok: true, value: { id: sandboxId, projectId: found.value.projectId } };
  }

  async destroy(sandboxId: string): Promise<VoidResult<SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;
    this.#sandboxes.delete(sandboxId);
    this.#destroyed.add(sandboxId);
    return { ok: true, value: undefined };
  }

  /** The lifetime each sandbox was last given, so a caller's keepalive can be asserted on. */
  timeoutOf(sandboxId: string): number | undefined {
    return this.#sandboxes.get(sandboxId)?.timeoutMs;
  }

  async extendTimeout(sandboxId: string, ms: number): Promise<VoidResult<SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;

    // Nothing here expires, so the value is recorded rather than acted on. That is the whole
    // observable effect the real one has too — a provider does not report its deadline back.
    found.value.timeoutMs = ms;
    return { ok: true, value: undefined };
  }

  async writeFile(
    sandboxId: string,
    path: string,
    contents: string,
  ): Promise<VoidResult<SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;
    found.value.files.set(normalize(path), contents);
    return { ok: true, value: undefined };
  }

  async readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;

    const contents = found.value.files.get(normalize(path));
    if (contents === undefined) return err("file_not_found", `no such file: ${path}`);
    return { ok: true, value: contents };
  }

  async listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;

    const dir = normalize(path);
    const prefix = dir === "/" ? "/" : `${dir}/`;
    // One level only, so a deep tree shows up as the directory that contains it.
    const children = new Map<string, FileNode["type"]>();

    for (const filePath of found.value.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const separator = rest.indexOf("/");
      if (separator === -1) {
        children.set(`${prefix}${rest}`, "file");
      } else {
        children.set(`${prefix}${rest.slice(0, separator)}`, "directory");
      }
    }

    return {
      ok: true,
      value: [...children].map(([childPath, type]) => ({ path: childPath, type })),
    };
  }

  async exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
  ): Promise<Result<ExecResult, SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;
    found.value.commands.push(command);

    const responder = this.#responderFor(command);
    if (responder === undefined) {
      // Deliberately thrown rather than returned: this is a mistake in the test, not
      // an outcome the production caller could handle.
      throw new Error(
        `InMemorySandboxManager: no scripted response for command ${JSON.stringify(command)}. ` +
          "Register one with script(), or pass defaultExec to the constructor.",
      );
    }

    const response = await responder(command);
    const chunks = response.chunks ?? derivedChunks(response);

    let stdout = "";
    let stderr = "";
    for (const chunk of chunks) {
      onOutput?.(chunk);
      if (chunk.stream === "stdout") stdout += chunk.data;
      else stderr += chunk.data;
    }

    return { ok: true, value: { exitCode: response.exitCode ?? 0, stdout, stderr } };
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<Result<string, SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;
    // Shaped like E2B's real preview host so callers that parse it work unchanged,
    // but on a reserved TLD that can never resolve.
    return { ok: true, value: `https://${port}-${sandboxId}.sandbox.invalid` };
  }

  async waitForPreview(
    sandboxId: string,
    port: number,
    _opts?: { timeoutMs?: number },
  ): Promise<Result<string, SandboxError>> {
    const found = this.#lookup(sandboxId);
    if (!found.ok) return found;

    if (!found.value.listening.has(port)) {
      // Reported immediately rather than after burning the caller's budget: readiness
      // here is a fact the test already decided, so sleeping would only slow the suite
      // down without making the outcome any more true.
      return err("timeout", `nothing is serving port ${port} in sandbox ${sandboxId}`);
    }

    return this.getPreviewUrl(sandboxId, port);
  }

  #lookup(sandboxId: string): Result<SandboxState, SandboxError> {
    const state = this.#sandboxes.get(sandboxId);
    if (state !== undefined) return { ok: true, value: state };
    if (this.#destroyed.has(sandboxId)) {
      return err("destroyed", `sandbox ${sandboxId} was destroyed`);
    }
    return err("not_found", `no such sandbox: ${sandboxId}`);
  }

  #responderFor(command: string): ExecResponder | undefined {
    const exact = this.#exactScripts.get(command);
    if (exact !== undefined) return exact;

    // Reverse order so the most recently registered pattern wins, matching the
    // override semantics an exact re-registration already has.
    for (const entry of [...this.#patternScripts].reverse()) {
      if (entry.pattern.test(command)) return entry.responder;
    }

    return this.#defaultExec;
  }
}

function derivedChunks(response: ScriptedExecResponse): ExecChunk[] {
  const chunks: ExecChunk[] = [];
  if (response.stdout !== undefined && response.stdout !== "") {
    chunks.push({ stream: "stdout", data: response.stdout });
  }
  if (response.stderr !== undefined && response.stderr !== "") {
    chunks.push({ stream: "stderr", data: response.stderr });
  }
  return chunks;
}
