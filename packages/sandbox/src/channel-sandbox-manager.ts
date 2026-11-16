/**
 * A machine somebody else built, used as a sandbox through nothing but a shell.
 *
 * Every other `SandboxManager` owns its machines: E2B's creates a VM, the local desktop one
 * starts a container. A benchmark task's container belongs to the harness that built it, which
 * also tears it down and judges what is left in it. So this adapter has exactly one machine,
 * "creating" a sandbox adopts it, destroying one only stops using it, and its lifetime is not
 * this side's to extend.
 *
 * All it is handed is an `ExecChannel` — run a command, get its exit code and output — and every
 * other operation is a command: files travel as base64 in the command line and back in its
 * output, so no byte depends on how the far side decodes text. That is narrower than a real
 * provider in two ways a caller can feel. Output arrives when the command ends rather than as it
 * is printed, and there is no preview to serve, since nothing outside the machine can reach it.
 *
 * Why not derive this from the local Docker desktop adapter: almost all of that one is the
 * desktop, the preview bridge and container lifecycle, none of which a task container has, and it
 * reaches its container by name over the Docker CLI, which ties it to one of Harbor's many kinds
 * of environment. See ADR-0035.
 */

import { listTreeViaExec } from "@nap/shared/list-tree";
import type {
  ExecOptions,
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";
import type { ExecChannel } from "./exec-channel.ts";

/** What a command may run for when its caller names no deadline: E2B's own default. */
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

/**
 * Base64 characters per write command. Linux caps one argument at 128 KiB, and the whole command
 * travels as one argument to `bash -c`, so a file larger than this goes over in pieces.
 */
export const WRITE_CHUNK_CHARS = 96 * 1_024;

/** How long the far side waits past a command's own deadline before giving up on the channel. */
const CHANNEL_GRACE_SEC = 15;

/** `timeout`'s exit status when it stopped the command. */
const TIMED_OUT = 124;

/** An exit status these scripts use for "no such file", out of the range commands usually use. */
const MISSING = 44;

const UNAVAILABLE: SandboxError = {
  code: "unavailable",
  message: "This machine serves no preview: nothing outside it can reach a port inside it.",
};

export class ChannelSandboxManager implements SandboxManager {
  readonly #id: string;
  readonly #channel: ExecChannel;
  #destroyed = false;

  constructor(options: { sandboxId: string; channel: ExecChannel }) {
    this.#id = options.sandboxId;
    this.#channel = options.channel;
  }

  /** The machine already exists; a sandbox "created" here is that machine, adopted. */
  async create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    if (this.#destroyed) return this.#gone();
    return { ok: true, value: { id: this.#id, projectId } };
  }

  async resume(sandboxId: string): Promise<Result<Pick<Sandbox, "id">, SandboxError>> {
    const known = this.#check(sandboxId);
    return known.ok ? { ok: true, value: { id: this.#id } } : known;
  }

  /** Stops using the machine. Removing it is the harness's job, after it has judged it. */
  async destroy(sandboxId: string): Promise<VoidResult<SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    this.#destroyed = true;
    return { ok: true, value: undefined };
  }

  /** Nothing to extend: the harness decides how long its machine lives. */
  async extendTimeout(sandboxId: string, _ms: number): Promise<VoidResult<SandboxError>> {
    return this.#check(sandboxId);
  }

  writeFile(sandboxId: string, path: string, contents: string): Promise<VoidResult<SandboxError>> {
    return this.writeFileBytes(sandboxId, path, new TextEncoder().encode(contents));
  }

  async readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>> {
    const bytes = await this.readFileBytes(sandboxId, path);
    return bytes.ok ? { ok: true, value: new TextDecoder().decode(bytes.value) } : bytes;
  }

  async writeFileBytes(
    sandboxId: string,
    path: string,
    contents: Uint8Array,
  ): Promise<VoidResult<SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    const encoded = Buffer.from(contents).toString("base64");
    const target = shellQuote(path);
    // The first piece truncates, so an overwrite never appends to what was there; an empty file
    // is one empty piece.
    const pieces: string[] = [];
    for (let at = 0; at < encoded.length; at += WRITE_CHUNK_CHARS)
      pieces.push(encoded.slice(at, at + WRITE_CHUNK_CHARS));
    if (pieces.length === 0) pieces.push("");

    for (const [index, piece] of pieces.entries()) {
      const into = index === 0 ? ">" : ">>";
      const prepare = index === 0 ? `mkdir -p -- "$(dirname -- ${target})" && ` : "";
      const ran = await this.#run(
        `${prepare}printf %s ${shellQuote(piece)} | base64 -d ${into} ${target}`,
      );
      if (!ran.ok) return ran;
      if (ran.value.exitCode !== 0)
        return {
          ok: false,
          error: {
            code: "exec_failed",
            message: `cannot write ${path}: ${ran.value.stderr.trim() || `exit ${ran.value.exitCode}`}`,
          },
        };
    }
    return { ok: true, value: undefined };
  }

  async readFileBytes(sandboxId: string, path: string): Promise<Result<Uint8Array, SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    const target = shellQuote(path);
    const ran = await this.#run(`[ -f ${target} ] || exit ${MISSING}; base64 < ${target}`);
    if (!ran.ok) return ran;
    if (ran.value.exitCode === MISSING)
      return { ok: false, error: { code: "file_not_found", message: `${path} does not exist` } };
    if (ran.value.exitCode !== 0)
      return {
        ok: false,
        error: { code: "exec_failed", message: `cannot read ${path}: ${ran.value.stderr.trim()}` },
      };
    // Line breaks in base64's output are skipped by the decoder.
    return { ok: true, value: new Uint8Array(Buffer.from(ran.value.stdout, "base64")) };
  }

  async listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    // One record per entry, NUL-terminated so any name survives. The three globs cover plain
    // names, dotfiles and names starting `..`; one that matches nothing stays literal and is
    // skipped by the existence test.
    const script =
      `cd -- ${shellQuote(path)} 2>/dev/null || exit ${MISSING}; ` +
      `for f in * .[!.]* ..?*; do ` +
      `{ [ -e "$f" ] || [ -L "$f" ]; } || continue; ` +
      `if [ -d "$f" ]; then printf 'd%s\\0' "$f"; else printf 'f%s\\0' "$f"; fi; done`;
    const ran = await this.#run(script);
    if (!ran.ok) return ran;
    if (ran.value.exitCode === MISSING)
      return { ok: false, error: { code: "file_not_found", message: `${path} does not exist` } };
    const base = path.replace(/\/+$/, "");
    const nodes = ran.value.stdout
      .split("\0")
      .filter((record) => record.length > 1)
      .map(
        (record): FileNode => ({
          path: `${base}/${record.slice(1)}`,
          type: record.startsWith("d") ? "directory" : "file",
        }),
      );
    return { ok: true, value: nodes };
  }

  listTree(
    sandboxId: string,
    root: string,
    options: { exclude: readonly string[]; timeoutMs: number },
  ): Promise<Result<string[], SandboxError>> {
    return listTreeViaExec(this, sandboxId, root, options);
  }

  /**
   * Runs a command to completion, then hands `onOutput` everything it printed at once.
   *
   * The deadline is enforced inside the machine with `timeout`, so a command that overruns is
   * stopped there whatever the channel does, which makes `stopOnGiveUp` true of every call. The
   * cost is one ambiguity: a command that itself exits 124 reads as timed out.
   */
  async exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
    options?: ExecOptions,
  ): Promise<Result<ExecResult, SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    const ran = await this.#run(command, options);
    if (!ran.ok) return ran;
    if (ran.value.exitCode === TIMED_OUT)
      return {
        ok: false,
        error: { code: "timeout", message: "The command ran past its deadline and was stopped." },
      };
    if (ran.value.stdout !== "") onOutput?.({ stream: "stdout", data: ran.value.stdout });
    if (ran.value.stderr !== "") onOutput?.({ stream: "stderr", data: ran.value.stderr });
    return ran;
  }

  async getPreviewUrl(sandboxId: string, _port: number): Promise<Result<string, SandboxError>> {
    const known = this.#check(sandboxId);
    return known.ok ? { ok: false, error: UNAVAILABLE } : known;
  }

  async waitForPreview(sandboxId: string, _port: number): Promise<Result<string, SandboxError>> {
    const known = this.#check(sandboxId);
    return known.ok ? { ok: false, error: UNAVAILABLE } : known;
  }

  /** One command through the channel, bounded inside the machine as well as on this side. */
  #run(command: string, options?: ExecOptions): Promise<Result<ExecResult, SandboxError>> {
    const seconds = Math.max(1, Math.ceil((options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) / 1_000));
    return this.#channel(`timeout -k 5 ${seconds} bash -c ${shellQuote(command)}`, {
      timeoutMs: (seconds + CHANNEL_GRACE_SEC) * 1_000,
      signal: options?.signal,
    });
  }

  #check(sandboxId: string): VoidResult<SandboxError> {
    if (sandboxId !== this.#id)
      return { ok: false, error: { code: "not_found", message: `No sandbox ${sandboxId}.` } };
    if (this.#destroyed) return this.#gone();
    return { ok: true, value: undefined };
  }

  #gone(): { ok: false; error: SandboxError } {
    return {
      ok: false,
      error: { code: "destroyed", message: `Sandbox ${this.#id} is no longer in use.` },
    };
  }
}
