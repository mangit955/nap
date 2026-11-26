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
 * output, so no byte depends on how the far side decodes text. Every command's output is framed
 * by markers this side chose, with the command's stderr collected apart and printed after its
 * stdout: Harbor's Docker environment folds stderr into stdout, so a stray warning from a shell
 * would otherwise land inside a file being read. That is narrower than a real
 * provider in two ways a caller can feel. Output arrives when the command ends rather than as it
 * is printed, and there is no preview to serve, since nothing outside the machine can reach it.
 *
 * Why not derive this from the local Docker desktop adapter: almost all of that one is the
 * desktop, the preview bridge and container lifecycle, none of which a task container has, and it
 * reaches its container by name over the Docker CLI, which ties it to one of Harbor's many kinds
 * of environment. See ADR-0035.
 */

import { randomUUID } from "node:crypto";
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

/** How long the parent waits past a command's own deadline before it reports a timeout. */
const CHANNEL_GRACE_SEC = 15;

/** `timeout`'s exit status when it stopped the command. */
const TIMED_OUT = 124;

/** How many times a read or a listing is tried when what came back is not base64. */
export const READ_ATTEMPTS = 2;

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
    const pieces: string[] = [];
    for (let at = 0; at < encoded.length; at += WRITE_CHUNK_CHARS)
      pieces.push(encoded.slice(at, at + WRITE_CHUNK_CHARS));
    if (pieces.length === 0) pieces.push("");
    // A file in one piece is written in place. One in several is assembled beside it and copied
    // over it at the end, so a piece that fails leaves the file as it was rather than cut short.
    // Copied, not moved, so the file keeps its mode and owner.
    const single = pieces.length === 1;
    const into = single ? target : shellQuote(`${path}.nap-part`);

    for (const [index, piece] of pieces.entries()) {
      const append = index === 0 ? ">" : ">>";
      const prepare = index === 0 ? `mkdir -p -- "$(dirname -- ${target})" && ` : "";
      const last = !single && index === pieces.length - 1;
      const ran = await this.#run(
        `${prepare}printf %s ${shellQuote(piece)} | base64 -d ${append} ${into}` +
          (last ? ` && cat ${into} > ${target} && rm -f ${into}` : ""),
      );
      if (!ran.ok) return ran;
      if (ran.value.exitCode !== 0)
        return {
          ok: false,
          error: {
            code: "exec_failed",
            message: `cannot write ${path}: ${reason(ran.value)}`,
          },
        };
    }
    return { ok: true, value: undefined };
  }

  async readFileBytes(sandboxId: string, path: string): Promise<Result<Uint8Array, SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    const target = shellQuote(path);
    const read = await this.#runBase64(
      `[ -f ${target} ] || exit ${MISSING}; base64 < ${target}`,
      `read ${path}`,
    );
    if (read === MISSING)
      return { ok: false, error: { code: "file_not_found", message: `${path} does not exist` } };
    return read.ok ? { ok: true, value: new Uint8Array(read.value) } : read;
  }

  async listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    const known = this.#check(sandboxId);
    if (!known.ok) return known;
    // One record per entry, NUL-terminated so any name survives. The three globs cover plain
    // names, dotfiles and names starting `..`; one that matches nothing stays literal and is
    // skipped by the existence test. Sent back as base64 for the same reason a file is: a stray
    // warning inside the raw records would come back as a name nobody created. `pipefail`, so a
    // loop that fails part-way still fails the listing rather than shortening it.
    const listed = await this.#runBase64(
      `cd -- ${shellQuote(path)} 2>/dev/null || exit ${MISSING}; set -o pipefail; ` +
        `for f in * .[!.]* ..?*; do ` +
        `{ [ -e "$f" ] || [ -L "$f" ]; } || continue; ` +
        `if [ -d "$f" ]; then printf 'd%s\\0' "$f"; else printf 'f%s\\0' "$f"; fi; done | base64`,
      `list ${path}`,
    );
    if (listed === MISSING)
      return { ok: false, error: { code: "file_not_found", message: `${path} does not exist` } };
    if (!listed.ok) return listed;
    const base = path.replace(/\/+$/, "");
    const nodes = listed.value
      .toString("utf8")
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

  /**
   * One command through the channel, bounded inside the machine, and with its output framed.
   *
   * The command's stdout is printed between two markers and its stderr, collected in a file,
   * after the second, so the two can be told apart whatever the channel does with the streams.
   * Anything outside the frame (a warning from the shell that ran the frame, a message from
   * `docker compose`) is kept as stderr. The markers carry a nonce and are assembled by `printf`
   * as they are printed, so they never appear whole in any command line: a command that lists
   * processes (`ps`) prints the frame's script, not its markers.
   *
   * The stderr file is the frame's one dependency beyond `bash` and `timeout`. A machine that
   * cannot make one (no `/tmp`, a full disk) still runs the command, with its stderr discarded.
   */
  async #run(command: string, options?: ExecOptions): Promise<Result<ExecResult, SandboxError>> {
    const seconds = Math.max(1, Math.ceil((options?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS) / 1_000));
    const nonce = randomUUID().replaceAll("-", "");
    const open = `@@nap-out-${nonce}@@`;
    const split = `@@nap-err-${nonce}@@`;
    const framed =
      `nap_err=$(mktemp 2>/dev/null) || nap_err=/dev/null; printf '@@nap-%s-%s@@' out ${nonce}; ` +
      `timeout -k 5 ${seconds} bash -c ${shellQuote(command)} 2>"$nap_err"; nap_status=$?; ` +
      `printf '@@nap-%s-%s@@' err ${nonce}; cat "$nap_err"; ` +
      `[ "$nap_err" = /dev/null ] || rm -f "$nap_err"; exit $nap_status`;
    const ran = await this.#channel(framed, {
      timeoutMs: (seconds + CHANNEL_GRACE_SEC) * 1_000,
      signal: options?.signal,
    });
    if (!ran.ok) return ran;
    return unframe(ran.value, open, split);
  }

  /**
   * Runs a script whose stdout is base64 and returns it decoded, or `MISSING` when the script
   * exits with that status. Twice at most: the frame keeps a command's own stderr apart, but the
   * shell that runs the frame can warn (a missing locale) on a stream the environment folds into
   * stdout, and two streams read separately can interleave, landing the warning inside the
   * output. Both callers only read, so one more attempt is the cheap answer to a rare reordering.
   */
  async #runBase64(
    script: string,
    what: string,
  ): Promise<Result<Buffer, SandboxError> | typeof MISSING> {
    for (let attempt = 1; ; attempt += 1) {
      const ran = await this.#run(script);
      if (!ran.ok) return ran;
      if (ran.value.exitCode === MISSING) return MISSING;
      if (ran.value.exitCode !== 0)
        return {
          ok: false,
          error: { code: "exec_failed", message: `cannot ${what}: ${reason(ran.value)}` },
        };
      // Checked, because Node's decoder skips what is not base64 rather than failing on it, and
      // output that came back with anything else in it must not be handed over as what was asked
      // for. Line breaks in base64's output are part of the format.
      if (/^[A-Za-z0-9+/=\s]*$/.test(ran.value.stdout))
        return { ok: true, value: Buffer.from(ran.value.stdout, "base64") };
      if (attempt === READ_ATTEMPTS)
        return {
          ok: false,
          error: { code: "exec_failed", message: `cannot ${what}: the output was not base64` },
        };
    }
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

/** The command's own stdout and stderr, out of what the channel returned for its frame. */
export function unframe(
  raw: ExecResult,
  open: string,
  split: string,
): Result<ExecResult, SandboxError> {
  const opened = raw.stdout.indexOf(open);
  if (opened === -1)
    return {
      ok: false,
      error: {
        code: "exec_failed",
        message: `the machine did not run the command (exit ${raw.exitCode}): ${(raw.stdout + raw.stderr).trim().slice(-500)}`,
      },
    };
  const before = raw.stdout.slice(0, opened);
  const body = raw.stdout.slice(opened + open.length);
  const splitAt = body.indexOf(split);
  // No second marker: the frame itself was stopped, so whatever the command printed is all there is.
  const stdout = splitAt === -1 ? body : body.slice(0, splitAt);
  const stderr = splitAt === -1 ? "" : body.slice(splitAt + split.length);
  return {
    ok: true,
    value: { exitCode: raw.exitCode, stdout, stderr: [stderr, before, raw.stderr].join("") },
  };
}

/** Why a command failed, in words: its stderr, else the end of its stdout, else its exit code. */
function reason(result: ExecResult): string {
  return result.stderr.trim() || result.stdout.trim().slice(-500) || `exit ${result.exitCode}`;
}
