import { describe, expect, it } from "vitest";
import {
  encodeNativeFrame,
  NativeFrameDecoder,
  NativeHostCommandSchema,
  NativeHostEventSchema,
} from "./native-process-protocol.ts";

const token = "a".repeat(64);

describe("native process framing", () => {
  it("round-trips fragmented and coalesced UTF-8 frames", () => {
    const frame = encodeNativeFrame({ type: "input", token, data: "hello 🌙\n" });
    const bytes = Buffer.from(frame + frame);
    const decoder = new NativeFrameDecoder(NativeHostCommandSchema, 4096);
    const values = [];
    for (const byte of bytes) values.push(...decoder.push(Uint8Array.of(byte)));
    decoder.finish();
    expect(values).toEqual([
      { type: "input", token, data: "hello 🌙\n" },
      { type: "input", token, data: "hello 🌙\n" },
    ]);
  });

  it("bounds each frame rather than the total size of a batch", () => {
    const decoder = new NativeFrameDecoder(NativeHostCommandSchema, 200);
    const frame = encodeNativeFrame({ type: "renew", token });
    expect(decoder.push(Buffer.from(frame.repeat(100)))).toHaveLength(100);
  });

  it("rejects an oversized unterminated frame without retaining its secret", () => {
    const decoder = new NativeFrameDecoder(NativeHostCommandSchema, 100);
    expect(() => decoder.push(Buffer.from("secret".repeat(30)))).toThrow("frame exceeds");
    expect(() => decoder.push(Buffer.from("\n"))).toThrow("decoder is closed");
  });

  it("rejects malformed, truncated, and unknown protocol messages without echoing input", () => {
    for (const input of ["private-token\n", '{"type":"unknown","secret":"private-token"}\n']) {
      const decoder = new NativeFrameDecoder(NativeHostCommandSchema, 4096);
      expect(() => decoder.push(Buffer.from(input))).toThrow("Invalid native process frame");
    }
    const decoder = new NativeFrameDecoder(NativeHostCommandSchema, 4096);
    decoder.push(Buffer.from('{"type":'));
    expect(() => decoder.finish()).toThrow("Truncated native process frame");
  });

  it("validates process limits and containment before accepting a start", () => {
    const start = {
      type: "start",
      token,
      executable: "/bin/cat",
      args: [],
      cwd: "/tmp",
      env: {},
      leaseMs: 1000,
      maxOutputBytes: 4096,
      maxReplayBytes: 4096,
      containment: { kind: "process_group" },
    };
    expect(NativeHostCommandSchema.safeParse(start).success).toBe(true);
    for (const change of [
      { leaseMs: 0 },
      { maxReplayBytes: 0 },
      { token: "short" },
      { terminal: { columns: 0, rows: 24 } },
      { terminal: { columns: 80, rows: 1001 } },
    ]) {
      expect(NativeHostCommandSchema.safeParse({ ...start, ...change }).success).toBe(false);
    }
    expect(
      NativeHostCommandSchema.safeParse({
        ...start,
        containment: { kind: "cgroup", root: "/sys/fs/cgroup", uid: 0, gid: 0 },
      }).success,
    ).toBe(false);
    expect(NativeHostEventSchema.safeParse({ type: "output", seq: 0 }).success).toBe(false);
  });
});
