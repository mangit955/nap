import { expect, it } from "vitest";
import { E2BSandboxDesktop } from "./e2b-sandbox-desktop.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";

const ref = { sandboxId: "sandbox-a", recordingId: "c7e61e1b-7116-4f9d-904c-78495407a65a" };
function fixture(values: unknown[]) {
  const sandbox = new InMemorySandboxManager();
  const requests: unknown[] = [];
  sandbox.exec = async (_id, command) => {
    const data = command.match(/'([A-Za-z0-9+/=]+)'$/)?.[1];
    requests.push(data ? JSON.parse(Buffer.from(data, "base64").toString()) : null);
    return {
      ok: true,
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, value: values.shift() }),
        stderr: "",
      },
    };
  };
  return { desktop: new E2BSandboxDesktop({ sandbox }), requests };
}
it("keeps recording lifecycle outside model actions and maps encoder time and binary video", async () => {
  const mp4 = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(20),
  ]);
  const f = fixture([
    { kind: "none" },
    { timeMs: 375 },
    { data: mp4.toString("base64"), durationMs: 1000, width: 1024, height: 768 },
    { kind: "none" },
  ]);
  expect(await f.desktop.begin(ref)).toEqual({ ok: true, value: undefined });
  expect(await f.desktop.timestamp(ref)).toEqual({ ok: true, value: 375 });
  expect(await f.desktop.finish(ref)).toEqual({
    ok: true,
    value: { bytes: Uint8Array.from(mp4), durationMs: 1000, width: 1024, height: 768 },
  });
  expect(await f.desktop.discard(ref)).toEqual({ ok: true, value: undefined });
  expect(f.requests).toEqual(
    ["recording_begin", "recording_timestamp", "recording_finish", "recording_discard"].map((op) =>
      expect.objectContaining({ op, recordingId: ref.recordingId }),
    ),
  );
});
it("rejects malformed recordings and invalid IDs before side effects", async () => {
  const f = fixture([{ data: "bm90LW1wNA==", durationMs: 1000, width: 1024, height: 768 }]);
  expect((await f.desktop.finish(ref)).ok).toBe(false);
  expect((await f.desktop.begin({ ...ref, recordingId: "../escape" })).ok).toBe(false);
  expect(f.requests).toHaveLength(1);
});
