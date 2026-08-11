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

export interface SandboxManager {
  create(projectId: string): Promise<Result<Sandbox, SandboxError>>;
  resume(sandboxId: string): Promise<Result<Sandbox, SandboxError>>;
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
  listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>>;

  exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
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
