import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopRecorder, type RecordingProcessHost } from "./desktop-recorder.ts";

const roots: string[] = [];
const first = "c7e61e1b-7116-4f9d-904c-78495407a65a";
const second = "65956985-30b9-49ba-a719-6fc9a3d46ef6";
const video = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(20),
]);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nap-recorder-"));
  roots.push(directory);
  const running = new Set<number>();
  let pid = 100;
  const host: RecordingProcessHost = {
    start: vi.fn(async ({ output, progress }) => {
      running.add(++pid);
      writeFileSync(output, video);
      writeFileSync(progress, "frame=1\nout_time_us=125000\nprogress=continue\n");
      return { pid, startTicks: String(pid) };
    }),
    running: vi.fn(async (identity) => running.has(identity.pid)),
    stop: vi.fn(async (identity) => {
      running.delete(identity.pid);
    }),
    probe: vi.fn(async () => ({ durationMs: 1250, width: 1024, height: 768 })),
  };
  return { directory, host, recorder: new DesktopRecorder({ directory, host }) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("starts one bounded capture and uses encoder progress for annotation time", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  await f.recorder.begin(first);
  expect(f.host.start).toHaveBeenCalledTimes(1);
  expect(await f.recorder.timestamp(first)).toBe(125);
  writeFileSync(
    join(f.directory, first, "progress"),
    "frame=3\nout_time_us=375000\nprogress=continue\nframe=4\nout_time_us=",
  );
  expect(await f.recorder.timestamp(first)).toBe(375);
  expect(f.host.start).toHaveBeenCalledWith(
    expect.objectContaining({ maxSeconds: 600, maxBytes: 14_000_000 }),
  );
});
it("does not replace a different active recording", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  await expect(f.recorder.begin(second)).rejects.toThrow();
  expect(f.host.start).toHaveBeenCalledTimes(1);
});
it("finishes by draining the encoder, validates the video, and permits an idempotent read", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  const clip = await f.recorder.finish(first);
  expect(clip).toEqual({
    bytes: Uint8Array.from(video),
    durationMs: 1250,
    width: 1024,
    height: 768,
  });
  expect(f.host.stop).toHaveBeenCalledTimes(1);
  expect(await f.recorder.finish(first)).toEqual(clip);
  expect(f.host.stop).toHaveBeenCalledTimes(1);
  await f.recorder.begin(second);
});
it("discards a recording without signalling a reused process identity", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  vi.mocked(f.host.running).mockResolvedValue(false);
  await f.recorder.discard(first);
  await f.recorder.discard(first);
  expect(f.host.stop).not.toHaveBeenCalled();
  expect(
    await f.recorder.finish(first).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
});
it.each(["../escape", "not-an-id"])(
  "rejects unsafe identity %s before filesystem or process effects",
  async (id) => {
    const f = fixture();
    await expect(f.recorder.begin(id)).rejects.toThrow();
    expect(f.host.start).not.toHaveBeenCalled();
  },
);
it("refuses missing progress and invalid or oversized clips", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  writeFileSync(join(f.directory, first, "progress"), "frame=0\n");
  await expect(f.recorder.timestamp(first)).rejects.toThrow();
  writeFileSync(join(f.directory, first, "capture.mp4"), "x".repeat(32));
  expect(
    await f.recorder.finish(first).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  writeFileSync(
    join(f.directory, first, "capture.mp4"),
    Buffer.concat([video, Buffer.alloc(16_000_001 - video.length)]),
  );
  expect(
    await f.recorder.finish(first).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
});
it.each([
  { durationMs: 0, width: 1024, height: 768 },
  { durationMs: 606_000, width: 1024, height: 768 },
  { durationMs: 1250, width: 5000, height: 768 },
  { durationMs: 1250, width: 1024, height: 5000 },
])("validates encoded metadata %j before exposing a completed file", async (metadata) => {
  const f = fixture();
  await f.recorder.begin(first);
  vi.mocked(f.host.probe).mockResolvedValue(metadata);
  await expect(f.recorder.finish(first)).rejects.toThrow();
});
it("drains and discards when cancellation arrives while the encoder is starting", async () => {
  const f = fixture();
  const controller = new AbortController();
  const start = f.host.start;
  f.host.start = async (options) => {
    const identity = await start(options);
    controller.abort();
    return identity;
  };
  await expect(f.recorder.begin(first, controller.signal)).rejects.toThrow();
  expect(f.host.stop).toHaveBeenCalledTimes(1);
  await expect(f.recorder.finish(first)).rejects.toThrow();
});
it("does not report a failed stop as a completed capture", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  vi.mocked(f.host.stop).mockRejectedValue(new Error("cannot drain"));
  await expect(f.recorder.finish(first)).rejects.toThrow();
  expect(f.host.probe).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(f.directory, "active.json"), "utf8"))).toMatchObject({
    recordingId: first,
  });
});
it("refuses malformed on-disk recording metadata", async () => {
  const f = fixture();
  mkdirSync(join(f.directory, first));
  writeFileSync(
    join(f.directory, first, "process.json"),
    JSON.stringify({ pid: -1, startTicks: "bad" }),
  );
  await expect(f.recorder.finish(first)).rejects.toThrow();
  expect(f.host.stop).not.toHaveBeenCalled();
});

it("waits for a first encoded frame when resuming a partially started capture", async () => {
  const f = fixture();
  const path = join(f.directory, first);
  mkdirSync(path);
  writeFileSync(join(path, "process.json"), JSON.stringify({ pid: 1, startTicks: "123" }));
  writeFileSync(join(path, "progress"), "frame=0\n");
  let checks = 0;
  vi.mocked(f.host.running).mockImplementation(async () => {
    if (++checks === 2) writeFileSync(join(path, "progress"), "frame=1\nout_time_us=125000\n");
    return true;
  });
  await f.recorder.begin(first);
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(f.host.start).not.toHaveBeenCalled();
});

it.each(["process.json", "active.json"])(
  "stops an encoder when persisting %s fails",
  async (file) => {
    const f = fixture();
    let live = false;
    const start = f.host.start;
    f.host.start = async (options) => {
      const identity = await start(options);
      live = true;
      mkdirSync(file === "active.json" ? join(f.directory, file) : join(f.directory, first, file));
      return identity;
    };
    vi.mocked(f.host.stop).mockImplementation(async () => {
      live = false;
    });
    await expect(f.recorder.begin(first)).rejects.toThrow();
    expect(f.host.stop).toHaveBeenCalledTimes(1);
    expect(live).toBe(false);
  },
);
it("retains recoverable process metadata when startup cleanup cannot drain", async () => {
  const f = fixture();
  const start = f.host.start;
  f.host.start = async (options) => {
    const identity = await start(options);
    mkdirSync(join(f.directory, "active.json"));
    return identity;
  };
  vi.mocked(f.host.stop).mockRejectedValue(new Error("cannot drain"));
  await expect(f.recorder.begin(first)).rejects.toThrow();
  expect(f.host.stop).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(join(f.directory, first, "process.json"), "utf8"))).toMatchObject({
    pid: 101,
  });
});
it("ignores a partially written numeric progress field", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  writeFileSync(
    join(f.directory, first, "progress"),
    "frame=3\nout_time_us=375000\nprogress=continue\nframe=4\nout_time_us=5",
  );
  expect(await f.recorder.timestamp(first)).toBe(375);
});

it("preserves an ended capture when a repeated begin is refused", async () => {
  const f = fixture();
  await f.recorder.begin(first);
  vi.mocked(f.host.running).mockResolvedValue(false);
  await expect(f.recorder.begin(first)).rejects.toThrow();
  expect(await f.recorder.finish(first)).toEqual({
    bytes: Uint8Array.from(video),
    durationMs: 1250,
    width: 1024,
    height: 768,
  });
});
