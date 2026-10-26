import { computerRecordingKey } from "@nap/shared/computer-artifacts";
import type { NapEventOf } from "@nap/shared/events";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";
import type { SandboxRecordings } from "@nap/shared/ports/sandbox-recordings";
import type { TestRecordingState } from "@nap/shared/test-recording";
import { TurnAbortError } from "@nap/shared/turn-abort";

export type AppTestRecordingClock = () => Promise<number | null>;

/** The test start is the deletion index even if capture or its upload announcement fails. */
export async function withAppTestRecording<T extends { ok: boolean }>(
  options: {
    projectId: string;
    sessionId: string;
    turnId: string;
    sandboxId: string;
    devServerUrl: string;
    started: NapEventOf<"test.started">["payload"];
    desktop: Pick<SandboxDesktop, "start">;
    recordings?: SandboxRecordings | undefined;
    objects: ObjectStore;
    signal?: AbortSignal | undefined;
    emit: {
      (type: "test.started", payload: NapEventOf<"test.started">["payload"]): void;
      (type: "test.recording", payload: NapEventOf<"test.recording">["payload"]): void;
    };
    beforeCapture: () => Promise<void>;
  },
  run: (clock: AppTestRecordingClock | undefined) => Promise<T>,
): Promise<T> {
  options.emit("test.started", options.started);
  await options.beforeCapture();
  const recordings = options.recordings;
  if (!recordings) return run(undefined);
  const ref = { sandboxId: options.sandboxId, recordingId: options.turnId };
  let captured = false;
  let lostClock = false;
  let interrupted = true;
  const leaseLost = () =>
    options.signal?.reason instanceof TurnAbortError && options.signal.reason.leaseLost;
  try {
    try {
      const desktop = await options.desktop.start({
        sandboxId: options.sandboxId,
        devServerUrl: options.devServerUrl,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (desktop.ok)
        captured = (
          await recordings.begin({ ...ref, ...(options.signal ? { signal: options.signal } : {}) })
        ).ok;
    } catch {
      /* A capture failure does not discard the test's assertions. */
    }
    if (captured) options.emit("test.recording", { recording: { state: "started" } });
    const clock: AppTestRecordingClock = async () => {
      if (lostClock) return null;
      try {
        const result = await recordings.timestamp(ref);
        if (
          result.ok &&
          Number.isInteger(result.value) &&
          result.value >= 0 &&
          result.value <= 605_000
        )
          return result.value;
      } catch {
        /* A broken timeline must never be advertised as a playable test recording. */
      }
      lostClock = true;
      return null;
    };
    const outcome = await run(captured ? clock : undefined);
    interrupted = !outcome.ok || options.signal?.aborted === true;
    return outcome;
  } finally {
    let recording: TestRecordingState = { state: "unavailable", reason: "capture_failed" };
    if (captured) {
      // Finish has its own deadline; the turn's aborted signal must not cut off MP4 finalization.
      try {
        const clip = await recordings.finish(ref);
        if (leaseLost()) recording = { state: "unavailable", reason: "lease_lost" };
        else if (lostClock) recording = { state: "unavailable", reason: "timing_failed" };
        else if (clip.ok) {
          const key = computerRecordingKey(options);
          const stored = await options.objects.put(key, clip.value.bytes);
          recording = leaseLost()
            ? { state: "unavailable", reason: "lease_lost" }
            : stored.ok
              ? {
                  state: "available",
                  key,
                  durationMs: clip.value.durationMs,
                  width: clip.value.width,
                  height: clip.value.height,
                  interrupted,
                }
              : { state: "unavailable", reason: "upload_failed" };
        }
      } catch {
        /* Keep the test result when capture or storage is unavailable. */
      }
    }
    try {
      options.emit("test.recording", { recording });
    } finally {
      await recordings.discard(ref).catch(() => undefined);
    }
  }
}
