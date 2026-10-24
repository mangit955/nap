import { expect, it } from "vitest";
import { FakeSandboxRecordings } from "./fake-sandbox-recordings.ts";

const ref = { sandboxId: "sandbox-a", recordingId: "c7e61e1b-7116-4f9d-904c-78495407a65a" };
const video = { bytes: new Uint8Array([1, 2, 3]), durationMs: 1000, width: 1024, height: 768 };
it("tracks independent sandbox captures, explicit encoder time and repeatable completion", async () => {
  const fake = new FakeSandboxRecordings(video);
  expect((await fake.timestamp(ref)).ok).toBe(false);
  expect((await fake.begin(ref)).ok).toBe(true);
  fake.advance(ref, 375);
  expect(await fake.timestamp(ref)).toEqual({ ok: true, value: 375 });
  expect((await fake.begin({ ...ref, recordingId: crypto.randomUUID() })).ok).toBe(false);
  expect((await fake.begin({ ...ref, sandboxId: "sandbox-b" })).ok).toBe(true);
  expect(await fake.finish(ref)).toEqual({ ok: true, value: video });
  const clip = await fake.finish(ref);
  if (clip.ok) clip.value.bytes[0] = 99;
  expect(await fake.finish(ref)).toEqual({ ok: true, value: video });
  expect(fake.calls.map((c) => c.operation)).toContain("finish");
});
it("honours cancellation, explicit failures and discard without inventing captures", async () => {
  const fake = new FakeSandboxRecordings(video);
  expect((await fake.begin({ ...ref, signal: AbortSignal.abort() })).ok).toBe(false);
  expect((await fake.finish(ref)).ok).toBe(false);
  await fake.begin(ref);
  fake.failWith({ code: "unavailable", message: "offline" });
  expect((await fake.timestamp(ref)).ok).toBe(false);
  fake.failWith(undefined);
  expect((await fake.discard(ref)).ok).toBe(true);
  expect((await fake.discard(ref)).ok).toBe(true);
  expect((await fake.finish(ref)).ok).toBe(false);
});
