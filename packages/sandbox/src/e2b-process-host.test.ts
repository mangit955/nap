import {
  encodeNativeFrame,
  NativeHostCommandSchema,
  type NativeHostEvent,
} from "@nap/shared/native-process-protocol";
import { describe, expect, it } from "vitest";
import { E2BProcessHost, type ProcessClient } from "./e2b-process-host.ts";

function fixture() {
  let notify: (text: string) => Promise<void> = async () => {};
  const sent: unknown[] = [];
  let disconnects = 0;
  let finish: () => void = () => {};
  const waited = new Promise<{ exitCode: number }>((resolve) => {
    finish = () => resolve({ exitCode: 0 });
  });
  const handle = {
    pid: 42,
    async sendStdin(text: string) {
      const message = NativeHostCommandSchema.parse(JSON.parse(text));
      sent.push(message);
      if (message.type === "start")
        await notify(encodeNativeFrame({ type: "ready", pid: 100, containment: "cgroup" }));
    },
    wait: () => waited,
    async disconnect() {
      disconnects++;
    },
  };
  const client: ProcessClient = {
    async start(_sandboxId, _path, output) {
      notify = output;
      return handle;
    },
    async connect(_sandboxId, _pid, output) {
      notify = output;
      return handle;
    },
  };
  return {
    host: new E2BProcessHost({ client, executablePath: "/opt/nap/host.mjs" }),
    sent,
    emit: (event: NativeHostEvent) => notify(encodeNativeFrame(event)),
    raw: (text: string) => notify(text),
    finish,
    disconnects: () => disconnects,
    client,
  };
}
const request = {
  sandboxId: "sandbox",
  executable: "/usr/bin/claude",
  args: [],
  cwd: "/home/user/app",
  env: {},
  leaseMs: 3000,
  maxOutputBytes: 65536,
  maxReplayBytes: 65536,
};

describe("E2B supervised process transport", () => {
  it("acknowledges only after the caller durably accepts output", async () => {
    const f = fixture();
    let persisted: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    const found = await f.host.start(request, async () => pending);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const delivery = f.emit({
      type: "output",
      seq: 1,
      stream: "stdout",
      data: Buffer.from("hello").toString("base64"),
    });
    await Promise.resolve();
    expect(f.sent.some((message) => NativeHostCommandSchema.parse(message).type === "ack")).toBe(
      false,
    );
    persisted();
    await delivery;
    expect(f.sent.at(-1)).toMatchObject({ type: "ack", sequence: 1 });
    await found.value.disconnect();
  });

  it("deduplicates replay and resumes from a durable cursor", async () => {
    const f = fixture();
    const events: unknown[] = [];
    const found = await f.host.connect(
      { sandboxId: "sandbox", pid: 42, token: "a".repeat(64), containment: "cgroup" },
      2,
      async (event) => {
        events.push(event);
      },
    );
    if (!found.ok) throw new Error("connect failed");
    expect(f.sent).toContainEqual({ type: "replay", token: "a".repeat(64), afterSequence: 2 });
    await f.emit({ type: "output", seq: 2, stream: "stdout", data: "b2xk" });
    await f.emit({ type: "output", seq: 3, stream: "stdout", data: "bmV3" });
    expect(events).toEqual([
      { kind: "output", sequence: 3, stream: "stdout", data: Buffer.from("new") },
    ]);
    await found.value.disconnect();
  });

  it("rejects missing events rather than advancing the cursor over a gap", async () => {
    const f = fixture();
    const found = await f.host.start(request, async () => {});
    if (!found.ok) throw new Error("start failed");
    await f.emit({ type: "output", seq: 2, stream: "stdout", data: "eA==" });
    expect(await found.value.closed).toMatchObject({
      ok: false,
      error: { code: "delivery_uncertain" },
    });
    expect(f.sent.some((message) => NativeHostCommandSchema.parse(message).type === "ack")).toBe(
      false,
    );
  });

  it("stops when persistence fails and keeps credentials out of the error", async () => {
    const f = fixture();
    const found = await f.host.start(request, async () => {
      throw new Error("private database credential");
    });
    if (!found.ok) throw new Error("start failed");
    await f.emit({ type: "output", seq: 1, stream: "stderr", data: "eA==" });
    const result = await found.value.closed;
    expect(result).toMatchObject({ ok: false, error: { code: "persistence_failed" } });
    expect(JSON.stringify(result)).not.toContain("private database credential");
    expect(f.sent.at(-1)).toMatchObject({ type: "stop" });
  });

  it("requires a terminal receipt even when the outer command exits successfully", async () => {
    const f = fixture();
    const found = await f.host.start(request, async () => {});
    if (!found.ok) throw new Error("start failed");
    f.finish();
    expect(await found.value.closed).toMatchObject({
      ok: false,
      error: { code: "delivery_uncertain" },
    });
  });

  it("preserves the host's exit and containment proof", async () => {
    const f = fixture();
    const found = await f.host.start(request, async () => {});
    if (!found.ok) throw new Error("start failed");
    await f.emit({ type: "exit", seq: 1, code: 0, reason: "exited", containment: "unknown" });
    expect(await found.value.closed).toEqual({
      ok: true,
      value: {
        kind: "exit",
        sequence: 1,
        code: 0,
        reason: "exited",
        containment: "unknown",
      },
    });
  });

  it("bounds startup even when sending the bootstrap frame never completes", async () => {
    const f = fixture();
    const host = new E2BProcessHost({
      executablePath: "/opt/nap/host.mjs",
      readyTimeoutMs: 20,
      client: {
        async start() {
          return {
            pid: 42,
            sendStdin: () => new Promise<void>(() => {}),
            wait: () => new Promise<{ exitCode: number }>(() => {}),
            disconnect: async () => {},
          };
        },
        connect: async () => {
          throw new Error("unused");
        },
      },
    });
    expect(await host.start(request, async () => {})).toMatchObject({
      ok: false,
      error: { code: "start_uncertain" },
    });
    expect(f.sent).toEqual([]);
  });

  it("acknowledges output emitted before connect returns its handle", async () => {
    const f = fixture();
    const host = new E2BProcessHost({
      executablePath: "/opt/nap/host.mjs",
      client: {
        ...f.client,
        async connect(id, pid, output) {
          await output(
            encodeNativeFrame({ type: "output", seq: 1, stream: "stdout", data: "eA==" }),
          );
          return f.client.connect(id, pid, output);
        },
      },
    });
    const found = await host.connect(
      { sandboxId: "sandbox", pid: 42, token: "a".repeat(64), containment: "cgroup" },
      0,
      async () => {},
    );
    if (!found.ok) throw new Error("connect failed");
    await f.emit({ type: "exit", seq: 2, code: 0, reason: "exited", containment: "cgroup" });
    expect(f.sent).toContainEqual({ type: "ack", token: "a".repeat(64), sequence: 1 });
  });

  it("bounds an unresponsive persistence callback without acknowledging it", async () => {
    const f = fixture();
    const host = new E2BProcessHost({
      executablePath: "/opt/nap/host.mjs",
      client: f.client,
      readyTimeoutMs: 20,
    });
    const found = await host.start(request, () => new Promise<void>(() => {}));
    if (!found.ok) throw new Error("start failed");
    await f.emit({ type: "output", seq: 1, stream: "stdout", data: "eA==" });
    expect(await found.value.closed).toMatchObject({
      ok: false,
      error: { code: "persistence_failed" },
    });
    expect(f.sent.some((message) => NativeHostCommandSchema.parse(message).type === "ack")).toBe(
      false,
    );
  });
});
