import type { Result } from "../result.ts";
import type { DesktopError } from "./sandbox-desktop.ts";

export type SandboxRecording = { sandboxId: string; recordingId: string };
export type RecordedVideo = {
  bytes: Uint8Array;
  durationMs: number;
  width: number;
  height: number;
};

/** Capture belongs to the machine; upload, event indexing and annotation ownership belong to runtime. */
export interface SandboxRecordings {
  begin(options: SandboxRecording & { signal?: AbortSignal }): Promise<Result<void, DesktopError>>;
  /** The encoder's presentation clock, never API wall time. */
  timestamp(recording: SandboxRecording): Promise<Result<number, DesktopError>>;
  /** Uses its own cleanup deadline even when the turn was cancelled. Safe to repeat. */
  finish(recording: SandboxRecording): Promise<Result<RecordedVideo, DesktopError>>;
  discard(recording: SandboxRecording): Promise<Result<void, DesktopError>>;
}
