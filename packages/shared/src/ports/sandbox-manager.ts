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

  writeFile(sandboxId: string, path: string, contents: string): Promise<VoidResult<SandboxError>>;
  readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>>;
  listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>>;

  exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
  ): Promise<Result<ExecResult, SandboxError>>;

  getPreviewUrl(sandboxId: string, port: number): Promise<Result<string, SandboxError>>;
}
