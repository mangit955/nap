import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { FakeSandboxRecordings } from "@nap/sandbox/testing/fake-sandbox-recordings";
import { type Logger, withLogContext } from "@nap/shared/logging";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { expect, it, vi } from "vitest";
import { withAppTestRecording } from "./app-test-recording.ts";

const identity = {
  projectId: "project",
  sessionId: "session",
  turnId: "c7e61e1b-7116-4f9d-904c-78495407a65a",
};
const started = { jobId: "job", commitSha: "abc", objective: "Save a note" };
const video = { bytes: new Uint8Array([1, 2, 3]), durationMs: 1000, width: 1024, height: 768 };
function fixture() {
  const desktop = new FakeSandboxDesktop({ bytes: new Uint8Array([1]), width: 1024, height: 768 });
  const recordings = new FakeSandboxRecordings(video);
  const objects = new InMemoryObjectStore();
  const order: string[] = [];
  const entries: { type: string; payload: unknown }[] = [];
  const emit = vi.fn((type: string, payload: unknown) => {
    entries.push({ type, payload });
    order.push(type);
  });
  const beforeCapture = vi.fn(async () => {
    order.push("durable");
  });
  const begin = recordings.begin.bind(recordings);
  vi.spyOn(recordings, "begin").mockImplementation(async (options) => {
    order.push("capture");
    return begin(options);
  });
  const put = objects.put.bind(objects);
  vi.spyOn(objects, "put").mockImplementation(async (key, bytes) => {
    order.push("upload");
    return put(key, bytes);
  });
  const options = {
    ...identity,
    started,
    desktop,
    recordings,
    objects,
    sandboxId: "sandbox",
    devServerUrl: "http://localhost:5173",
    emit,
    beforeCapture,
  };
  return { desktop, recordings, objects, order, entries, options };
}
it("reserves the recording identity durably before capture and announces only stored video", async () => {
  const f = fixture();
  const result = await withAppTestRecording(f.options, async (clock) => {
    f.order.push("run");
    f.recordings.advance({ sandboxId: "sandbox", recordingId: identity.turnId }, 375);
    expect(await clock?.()).toBe(375);
    return { ok: true };
  });
  expect(result).toEqual({ ok: true });
  expect(f.order).toEqual([
    "test.started",
    "durable",
    "capture",
    "test.recording",
    "run",
    "upload",
    "test.recording",
  ]);
  const key = `computer/project/session/${identity.turnId}/recording.mp4`;
  expect(await f.objects.get(key)).toEqual({ ok: true, value: video.bytes });
  expect(f.entries.at(-1)).toEqual({
    type: "test.recording",
    payload: {
      recording: {
        state: "available",
        key,
        durationMs: 1000,
        width: 1024,
        height: 768,
        interrupted: false,
      },
    },
  });
  expect(f.recordings.calls.at(-1)?.operation).toBe("discard");
});
it("does not capture or run if the durable reservation fails", async () => {
  const f = fixture();
  const run = vi.fn(async () => ({ ok: true }));
  await expect(
    withAppTestRecording(
      {
        ...f.options,
        beforeCapture: async () => {
          throw new Error("database offline");
        },
      },
      run,
    ),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(f.recordings.calls).toHaveLength(0);
});
it("keeps unrecorded test turns usable when no capture adapter is composed", async () => {
  const f = fixture();
  await withAppTestRecording({ ...f.options, recordings: undefined }, async (clock) => {
    expect(clock).toBeUndefined();
    return { ok: true };
  });
  expect(f.recordings.calls).toHaveLength(0);
  expect(f.entries.map((e) => e.type)).toEqual(["test.started"]);
});
it("preserves interrupted video using a fresh cleanup context after turn cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  await withAppTestRecording({ ...f.options, signal: controller.signal }, async () => {
    controller.abort();
    return { ok: false };
  });
  expect(f.entries.at(-1)).toMatchObject({
    payload: { recording: { state: "available", interrupted: true } },
  });
  expect(f.recordings.calls.filter((c) => c.operation === "finish")).toHaveLength(1);
});
it("finishes capture on a thrown turn error and propagates the original error", async () => {
  const f = fixture();
  const error = new Error("turn failed");
  await expect(
    withAppTestRecording(f.options, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(f.entries.at(-1)).toMatchObject({
    payload: { recording: { state: "available", interrupted: true } },
  });
});
it("keeps assertion execution when capture cannot start without claiming a recording exists", async () => {
  const f = fixture();
  f.recordings.failWith({ code: "unavailable", message: "private failure detail" });
  await withAppTestRecording(f.options, async (clock) => {
    expect(clock).toBeUndefined();
    return { ok: true };
  });
  expect(f.entries.at(-1)).toEqual({
    type: "test.recording",
    payload: { recording: { state: "unavailable", reason: "capture_failed" } },
  });
  expect(JSON.stringify(f.entries)).not.toContain("private failure detail");
});
it("does not publish a video whose annotation clock was lost", async () => {
  const f = fixture();
  vi.spyOn(f.recordings, "timestamp").mockResolvedValue({
    ok: false,
    error: { code: "unavailable", message: "clock unavailable" },
  });
  await withAppTestRecording(f.options, async (clock) => {
    expect(await clock?.()).toBeNull();
    return { ok: true };
  });
  expect(f.objects.put).not.toHaveBeenCalled();
  expect(f.entries.at(-1)).toMatchObject({
    payload: { recording: { state: "unavailable", reason: "timing_failed" } },
  });
  expect(f.recordings.calls.at(-1)?.operation).toBe("discard");
});
it("leaves a durable cleanup index when upload succeeds but its announcement throws", async () => {
  const f = fixture();
  const emit = (type: string, payload: unknown) => {
    if (
      type === "test.recording" &&
      typeof payload === "object" &&
      payload &&
      "recording" in payload &&
      typeof payload.recording === "object" &&
      payload.recording &&
      "state" in payload.recording &&
      payload.recording.state === "available"
    )
      throw new Error("append failed");
    f.options.emit(type, payload);
  };
  await expect(
    withAppTestRecording({ ...f.options, emit }, async () => ({ ok: true })),
  ).rejects.toThrow("append failed");
  expect(f.entries[0]).toEqual({ type: "test.started", payload: started });
  expect(
    (await f.objects.get(`computer/project/session/${identity.turnId}/recording.mp4`)).ok,
  ).toBe(true);
});
it("reports upload failure without changing assertion outcome", async () => {
  const f = fixture();
  vi.mocked(f.objects.put).mockResolvedValue({
    ok: false,
    error: { code: "unavailable", message: "private storage reason" },
  });
  expect(await withAppTestRecording(f.options, async () => ({ ok: true }))).toEqual({ ok: true });
  expect(f.entries.at(-1)).toMatchObject({
    payload: { recording: { state: "unavailable", reason: "upload_failed" } },
  });
});

it.each(["before_upload", "during_upload"] as const)(
  "does not advertise video after lease loss %s",
  async (mode) => {
    const { TurnAbortError } = await import("@nap/shared/turn-abort");
    const f = fixture();
    const controller = new AbortController();
    if (mode === "during_upload")
      vi.mocked(f.objects.put).mockImplementation(async () => {
        controller.abort(new TurnAbortError("lease_lost"));
        return { ok: true, value: undefined };
      });
    await withAppTestRecording({ ...f.options, signal: controller.signal }, async () => {
      if (mode === "before_upload") controller.abort(new TurnAbortError("lease_lost"));
      return { ok: false };
    });
    expect(f.entries.at(-1)).toEqual({
      type: "test.recording",
      payload: { recording: { state: "unavailable", reason: "lease_lost" } },
    });
    if (mode === "before_upload") expect(f.objects.put).not.toHaveBeenCalled();
    expect(f.recordings.calls.at(-1)?.operation).toBe("discard");
  },
);

it("waits for video storage before announcing availability", async () => {
  const f = fixture();
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const put = vi.mocked(f.objects.put).getMockImplementation();
  if (!put) throw new Error("Missing storage implementation.");
  vi.mocked(f.objects.put).mockImplementation(async (key, bytes) => {
    entered?.();
    await gate;
    return put(key, bytes);
  });
  const pending = withAppTestRecording(f.options, async () => ({ ok: true }));
  await started;
  expect(
    f.entries.some(
      (entry) =>
        entry.type === "test.recording" &&
        typeof entry.payload === "object" &&
        entry.payload &&
        "recording" in entry.payload &&
        typeof entry.payload.recording === "object" &&
        entry.payload.recording &&
        "state" in entry.payload.recording &&
        entry.payload.recording.state === "available",
    ),
  ).toBe(false);
  if (!release) throw new Error("Storage gate missing.");
  release();
  await pending;
  expect(f.entries.at(-1)).toMatchObject({ payload: { recording: { state: "available" } } });
});

it("notices lease loss after a cancellation has already fixed the abort reason", async () => {
  const { TurnAbortError } = await import("@nap/shared/turn-abort");
  const reason = new TurnAbortError("cancelled");
  const controller = new AbortController();
  const f = fixture();
  vi.mocked(f.objects.put).mockImplementation(async () => {
    reason.markLeaseLost();
    return { ok: true, value: undefined };
  });
  await withAppTestRecording({ ...f.options, signal: controller.signal }, async () => {
    controller.abort(reason);
    return { ok: false };
  });
  expect(f.entries.at(-1)).toMatchObject({
    payload: { recording: { state: "unavailable", reason: "lease_lost" } },
  });
});

type LogLine = { level: string; fields: Record<string, unknown>; message: string };
function logRecorder(bindings: Record<string, unknown> = {}, lines: LogLine[] = []) {
  const at =
    (level: string) =>
    (first: object | string, second?: string): void => {
      lines.push(
        typeof first === "string"
          ? { level, fields: { ...bindings }, message: first }
          : { level, fields: { ...bindings, ...first }, message: second ?? "" },
      );
    };
  const logger: Logger = {
    child: (extra) => logRecorder({ ...bindings, ...extra }, lines).logger,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
  return { logger, lines };
}
const unavailable = { code: "unavailable", message: "Nap's computer is unavailable." } as const;

it("logs which capture step failed, under the turn's log context, without publishing it", async () => {
  const f = fixture();
  vi.spyOn(f.desktop, "start").mockResolvedValue({ ok: false, error: unavailable });
  const log = logRecorder();
  await withLogContext(log.logger, { turnId: identity.turnId }, () =>
    withAppTestRecording(f.options, async () => ({ ok: true })),
  );
  const failures = log.lines.filter((line) => line.message === "test recording could not start");
  expect(failures.map((line) => line.fields)).toEqual([
    expect.objectContaining({ turnId: identity.turnId, step: "desktop_start", attempt: 1 }),
    expect.objectContaining({ turnId: identity.turnId, step: "desktop_start", attempt: 2 }),
  ]);
  expect(failures[0]?.fields).toMatchObject({
    code: "unavailable",
    error: unavailable.message,
    elapsedMs: expect.any(Number),
  });
  expect(f.recordings.calls).toHaveLength(1);
  expect(f.entries.at(-1)).toEqual({
    type: "test.recording",
    payload: { recording: { state: "unavailable", reason: "capture_failed" } },
  });
});

it("logs a thrown capture failure with its error", async () => {
  const f = fixture();
  const error = new Error("exec transport closed");
  vi.spyOn(f.recordings, "begin").mockRejectedValue(error);
  const log = logRecorder();
  await withLogContext(log.logger, {}, () =>
    withAppTestRecording(f.options, async () => ({ ok: true })),
  );
  expect(log.lines.find((line) => line.level === "warn")?.fields).toMatchObject({
    step: "recording_begin",
    attempt: 1,
    err: error,
  });
});

it("records the test when the desktop starts on its second attempt", async () => {
  const f = fixture();
  const start = f.desktop.start.bind(f.desktop);
  vi.spyOn(f.desktop, "start")
    .mockResolvedValueOnce({ ok: false, error: unavailable })
    .mockImplementation(start);
  const log = logRecorder();
  await withLogContext(log.logger, {}, () =>
    withAppTestRecording(f.options, async (clock) => {
      expect(clock).toBeDefined();
      return { ok: true };
    }),
  );
  expect(f.desktop.start).toHaveBeenCalledTimes(2);
  expect(log.lines.filter((line) => line.level === "warn")).toHaveLength(1);
  expect(f.entries.map((entry) => entry.payload)).toContainEqual({
    recording: { state: "started" },
  });
  expect(f.entries.at(-1)).toMatchObject({ payload: { recording: { state: "available" } } });
});

it("never begins a recording twice, since a lost reply may still be spawning its encoder", async () => {
  const f = fixture();
  vi.mocked(f.recordings.begin).mockResolvedValue({ ok: false, error: unavailable });
  const log = logRecorder();
  await withLogContext(log.logger, {}, () =>
    withAppTestRecording(f.options, async () => ({ ok: true })),
  );
  expect(f.recordings.begin).toHaveBeenCalledTimes(1);
  expect(log.lines.map((line) => line.fields)).toEqual([
    expect.objectContaining({ step: "recording_begin", code: "unavailable" }),
  ]);
});

it("runs ffmpeg once for a screenshot after the desktop starts and before the encoder", async () => {
  const f = fixture();
  const calls: string[] = [];
  const start = f.desktop.start.bind(f.desktop);
  const screenshot = f.desktop.screenshot.bind(f.desktop);
  vi.spyOn(f.desktop, "start").mockImplementation(async (request) => {
    calls.push("start");
    return start(request);
  });
  vi.spyOn(f.desktop, "screenshot").mockImplementation(async (sandboxId, signal) => {
    calls.push("screenshot");
    return screenshot(sandboxId, signal);
  });
  vi.mocked(f.recordings.begin).mockImplementation(async () => {
    calls.push("begin");
    return { ok: true, value: undefined };
  });
  await withAppTestRecording(f.options, async () => ({ ok: true }));
  expect(calls).toEqual(["start", "screenshot", "begin"]);
});

it("still begins the recording when the warm-up screenshot fails", async () => {
  const f = fixture();
  vi.spyOn(f.desktop, "screenshot").mockRejectedValue(new Error("ffmpeg exited"));
  const log = logRecorder();
  await withLogContext(log.logger, {}, () =>
    withAppTestRecording(f.options, async () => ({ ok: true })),
  );
  expect(log.lines.map((line) => [line.message, line.fields.step])).toEqual([
    ["test recording warm-up failed", "encoder_warmup"],
  ]);
  expect(f.entries.at(-1)).toMatchObject({ payload: { recording: { state: "available" } } });
});

it.each([
  ["cancelled", { code: "cancelled", message: "Desktop operation cancelled." }],
  ["outdated", { code: "outdated", message: "Nap's computer is unavailable in this workspace." }],
  ["timed out", { code: "timeout", message: "Nap's computer is unavailable." }],
] as const)("does not retry a %s desktop start", async (_name, error) => {
  const f = fixture();
  vi.spyOn(f.desktop, "start").mockResolvedValue({ ok: false, error });
  await withAppTestRecording(f.options, async () => ({ ok: true }));
  expect(f.desktop.start).toHaveBeenCalledTimes(1);
});

it("does not retry the desktop start once the turn is aborted", async () => {
  const f = fixture();
  const controller = new AbortController();
  const start = vi.spyOn(f.desktop, "start").mockImplementation(async () => {
    controller.abort();
    return { ok: false, error: unavailable };
  });
  await withAppTestRecording({ ...f.options, signal: controller.signal }, async () => ({
    ok: false,
  }));
  expect(start).toHaveBeenCalledTimes(1);
});

it("does not log a cancelled capture as a failure", async () => {
  const f = fixture();
  vi.spyOn(f.desktop, "start").mockResolvedValue({
    ok: false,
    error: { code: "cancelled", message: "Desktop operation cancelled." },
  });
  const log = logRecorder();
  await withLogContext(log.logger, {}, () =>
    withAppTestRecording(f.options, async () => ({ ok: false })),
  );
  expect(log.lines).toEqual([]);
});
