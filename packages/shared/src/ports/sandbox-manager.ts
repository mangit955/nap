/**
 * The execution plane, behind one interface.
 *
 * Everything the agent does to a user's project — writing files, running commands,
 * exposing a preview — goes through here. It deliberately knows nothing about agents,
 * turns, or events: swapping E2B for Kubernetes must be a change to one package.
 *
 * Every method returns a `Result`. A missing file and an unreachable sandbox are
 * ordinary outcomes on this boundary, and a caller that forgets to handle them should
 * fail to compile rather than throw at runtime.
 */

import type { Result, VoidResult } from "../result.ts";

export type SandboxErrorCode =
  | "not_found"
  | "file_not_found"
  | "unavailable"
  | "destroyed"
  | "timeout"
  | "exec_failed";

export type SandboxError = {
  code: SandboxErrorCode;
  message: string;
};

export type Sandbox = {
  id: string;
  projectId: string;
};

export type FileNode = {
  path: string;
  type: "file" | "directory";
};

export type ExecResult = {
  /** Non-zero is reported here, not thrown — a failing command is data, not an error. */
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Receives output as it arrives, so a caller can stream it before `exec` resolves. */
export type ExecOutputHandler = (chunk: { stream: "stdout" | "stderr"; data: string }) => void;

export type ExecOptions = {
  /** Stops the caller waiting. Alone, it says nothing about the command, which may carry on. */
  signal?: AbortSignal | undefined;
  /**
   * How long the command may run before the provider stops it and the call fails with `timeout`.
   * Absent is the provider's own default, which on E2B is one minute.
   */
  timeoutMs?: number | undefined;
  /**
   * When this call gives up on the command, by `signal` or by `timeoutMs`, also stop the command
   * and everything it started. Neither of those does that alone.
   *
   * Opt-in, because stopping is not always the right thing: the desktop driver has to live long
   * enough to release what it holds, and its caller asks it to through a cancel of its own.
   * Repository setup does not use it either, because its script owns a process group of its own.
   *
   * Best effort even so: the stop is one more request to the sandbox, so a sandbox that cannot be
   * reached keeps whatever it was running.
   */
  stopOnGiveUp?: boolean | undefined;
};

export type ResumeOptions = {
  /**
   * Keep the sandbox alive for at least this long from now, in the same request as the resume.
   *
   * Part of the resume rather than an `extendTimeout` after it, because a turn does both before
   * anything else and the second would be one more round trip, made after the first, on every turn.
   * "At least" because E2B's resume only ever lengthens a deadline. Absent, the deadline is the
   * provider's business, which on E2B may still mean being lengthened to its five-minute default.
   */
  keepAliveMs?: number | undefined;
};

export interface SandboxManager {
  create(projectId: string): Promise<Result<Sandbox, SandboxError>>;
  /**
   * The sandbox, if it is still there. Answers with its id and nothing else: what project it was
   * made for is the session's to know, and asking the provider for it would be another request.
   */
  resume(
    sandboxId: string,
    options?: ResumeOptions,
  ): Promise<Result<Pick<Sandbox, "id">, SandboxError>>;
  destroy(sandboxId: string): Promise<VoidResult<SandboxError>>;

  /**
   * Keeps the sandbox alive for `ms` from now, replacing whatever deadline it had.
   *
   * Sandboxes are billed by the second, so every provider kills them on a timer — and the
   * timer starts at creation, not at the last thing anyone did. Without something to push it
   * back, a workspace disappears out from under a conversation that is still going on. The
   * caller that knows a project is being used is the one that must say so.
   */
  extendTimeout(sandboxId: string, ms: number): Promise<VoidResult<SandboxError>>;

  writeFile(sandboxId: string, path: string, contents: string): Promise<VoidResult<SandboxError>>;
  readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>>;

  /**
   * As `writeFile` and `readFile`, for contents that are not text: exactly these bytes, both ways.
   *
   * For what has to arrive unchanged and would be larger in any text encoding, which today is a
   * snapshot's git bundle. Before these, the bundle was carried as base64 through a command's
   * output: a third larger, and streamed through the command channel, on every turn.
   */
  writeFileBytes(
    sandboxId: string,
    path: string,
    contents: Uint8Array,
  ): Promise<VoidResult<SandboxError>>;
  readFileBytes(sandboxId: string, path: string): Promise<Result<Uint8Array, SandboxError>>;
  listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>>;

  /**
   * Every file under `root`, as absolute paths in no particular order, in **one** call.
   *
   * One call is the contract, not an optimisation: a walk of `listFiles` is a round trip per
   * folder, made one after another, and the context engine asks this on every model turn before
   * anything reaches the model. Lists what is on disk, so a file deleted but not yet committed is
   * absent; leaves out what git ignores when `root` is a repository; and never returns a path with
   * a segment named in `exclude` — nor spends time descending into one. Not a promise of every
   * file: an implementation may cap a very large tree, and a symlink may or may not be listed.
   */
  listTree(
    sandboxId: string,
    root: string,
    options: { exclude: readonly string[]; timeoutMs: number },
  ): Promise<Result<string[], SandboxError>>;

  /** A transport signal bounds waiting; it never certifies remote process completion. */
  exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
    options?: ExecOptions,
  ): Promise<Result<ExecResult, SandboxError>>;

  getPreviewUrl(sandboxId: string, port: number): Promise<Result<string, SandboxError>>;

  /**
   * Resolves once the preview URL actually serves, or fails with `timeout`.
   *
   * Distinct from `getPreviewUrl`, which only composes an address and says nothing about
   * whether anything answers at it. A dev server takes time to boot, and the address is
   * reachable through a public proxy that becomes ready separately — so a caller that
   * showed the URL as soon as it had one would show an error page. Waiting for a real
   * response is the only honest signal, and it carries a deadline so a server that never
   * comes up reports a failure instead of hanging a turn.
   */
  waitForPreview(
    sandboxId: string,
    port: number,
    opts?: { timeoutMs?: number },
  ): Promise<Result<string, SandboxError>>;
}
