/** Interactive processes are separate from one-shot sandbox commands and their aggregate output. */
import type { z } from "zod";
import type { NativeHostExitReason, NativeTerminalSizeSchema } from "../native-process-protocol.ts";
import type { Result, VoidResult } from "../result.ts";

export type ProcessError = {
  code:
    | "invalid_request"
    | "start_uncertain"
    | "delivery_uncertain"
    | "persistence_failed"
    | "unavailable"
    | "disconnected";
  message: string;
};
export type ProcessOutput = {
  kind: "output";
  sequence: number;
  stream: "stdout" | "stderr";
  data: Uint8Array;
};
export type ProcessExit = {
  kind: "exit";
  sequence: number;
  code: number | null;
  reason: NativeHostExitReason;
  /** Only cgroup containment proves detached descendants cannot keep writing. */
  containment: "cgroup" | "process_group" | "unknown";
};
export type ProcessEvent = ProcessOutput | ProcessExit;

export type TerminalSize = z.infer<typeof NativeTerminalSizeSchema>;
/** Private reconnect material. Never put this reference in an event, URL, or browser response. */
export type ProcessReference = {
  terminal?: boolean;
  sandboxId: string;
  pid: number;
  token: string;
  containment: "cgroup" | "process_group";
};
export type ProcessStart = {
  terminal?: TerminalSize;
  sandboxId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  leaseMs: number;
  maxOutputBytes: number;
  maxReplayBytes: number;
};

export interface SandboxProcess {
  readonly reference: ProcessReference;
  readonly closed: Promise<Result<ProcessExit, ProcessError>>;
  /** Authenticated physical proof, independent of output decoding/persistence success. */
  readonly termination?: Promise<Result<ProcessExit, ProcessError>>;
  write(data: string): Promise<VoidResult<ProcessError>>;
  resize(size: TerminalSize): Promise<VoidResult<ProcessError>>;
  renew(): Promise<VoidResult<ProcessError>>;
  interrupt(): Promise<VoidResult<ProcessError>>;
  /** Requests termination. Await closed and inspect containment before finalizing files. */
  stop(): Promise<VoidResult<ProcessError>>;
  /** Drops the stream only. The host lease remains the upper bound on orphan execution. */
  disconnect(): Promise<VoidResult<ProcessError>>;
}

export interface SandboxProcessHost {
  /** Resolving onEvent must mean its output and delivery identity have been persisted. */
  start(
    request: ProcessStart,
    onEvent: (event: ProcessEvent) => Promise<void>,
  ): Promise<Result<SandboxProcess, ProcessError>>;
  connect(
    reference: ProcessReference,
    afterSequence: number,
    onEvent: (event: ProcessEvent) => Promise<void>,
  ): Promise<Result<SandboxProcess, ProcessError>>;
}
