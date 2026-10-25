import {
  encodeNativeFrame,
  NativeHostCommandSchema,
  type NativeHostEvent,
} from "@nap/shared/native-process-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  attachedE2BProcessClient,
  E2BProcessHost,
  type ProcessClient,
} from "./e2b-process-host.ts";

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

it("starts and reconnects a terminal with validated resize controls", async () => {
  const f = fixture();
  const found = await f.host.start(
    { ...request, terminal: { columns: 80, rows: 24 } },
    async () => {},
  );
  if (!found.ok) throw new Error("terminal start failed");
  expect(f.sent[0]).toMatchObject({ terminal: { columns: 80, rows: 24 } });
  expect(await found.value.resize({ columns: 100, rows: 40 })).toMatchObject({ ok: true });
  expect(f.sent.at(-1)).toMatchObject({ type: "resize", columns: 100, rows: 40 });
  const count = f.sent.length;
  expect(await found.value.resize({ columns: 0, rows: 40 })).toMatchObject({
    ok: false,
    error: { code: "invalid_request" },
  });
  expect(f.sent).toHaveLength(count);
  const reference = found.value.reference;
  await found.value.disconnect();
  const connected = await f.host.connect(reference, 0, async () => {});
  if (!connected.ok) throw new Error("terminal reconnect failed");
  expect(await connected.value.resize({ columns: 110, rows: 45 })).toMatchObject({ ok: true });
  await connected.value.disconnect();
});

it("refuses terminal controls on a pipe process without disturbing its channel", async () => {
  const f = fixture();
  const found = await f.host.start(request, async () => {});
  if (!found.ok) throw new Error("pipe start failed");
  const count = f.sent.length;
  expect(await found.value.resize({ columns: 80, rows: 24 })).toMatchObject({
    ok: false,
    error: { code: "invalid_request" },
  });
  expect(f.sent).toHaveLength(count);
  expect(await found.value.write("still connected")).toMatchObject({ ok: true });
  await found.value.disconnect();
});

it.each([
  ["queued", "cgroup"],
  ["later", "cgroup"],
  ["later", "unknown"],
] as const)(
  "preserves a %s terminal receipt with %s containment after an output ACK loses its command response",
  async (timing, containment) => {
    const f = fixture();
    let rejectAck: (error: Error) => void = () => {};
    let ackStarted: () => void = () => {};
    const acknowledging = new Promise<void>((resolve) => {
      ackStarted = resolve;
    });
    const client: ProcessClient = {
      ...f.client,
      async start(id, path, output) {
        const handle = await f.client.start(id, path, output);
        return {
          ...handle,
          sendStdin: async (text: string) => {
            const command = NativeHostCommandSchema.parse(JSON.parse(text));
            if (command.type !== "ack") return handle.sendStdin(text);
            ackStarted();
            return new Promise<void>((_resolve, reject) => {
              rejectAck = reject;
            });
          },
        };
      },
    };
    const host = new E2BProcessHost({
      client,
      executablePath: "/opt/nap/host.mjs",
      readyTimeoutMs: 100,
    });
    const found = await host.start(request, async () => {});
    if (!found.ok) throw new Error("start failed");
    const output = f.emit({ type: "output", seq: 1, stream: "stdout", data: "eA==" });
    await acknowledging;
    let terminal: Promise<void> | undefined;
    const receipt = {
      type: "exit",
      seq: 2,
      code: 0,
      reason: "stopped",
      containment,
    } as const;
    if (timing === "queued") terminal = f.emit(receipt);
    rejectAck(new Error("process already exited"));
    await output;
    f.finish();
    await Promise.resolve();
    await Promise.resolve();
    if (timing === "later") terminal = f.emit(receipt);
    await terminal;
    expect(await found.value.closed).toMatchObject({
      ok: true,
      value: { containment, reason: "stopped" },
    });
  },
);

it("bounds command uncertainty and prevents writes or renewals from reviving the process", async () => {
  const f = fixture();
  const client: ProcessClient = {
    ...f.client,
    async start(id, path, output) {
      const handle = await f.client.start(id, path, output);
      return {
        ...handle,
        sendStdin: async (text: string) => {
          const command = NativeHostCommandSchema.parse(JSON.parse(text));
          if (command.type === "input") throw new Error("private transport detail");
          return handle.sendStdin(text);
        },
      };
    },
  };
  const host = new E2BProcessHost({
    client,
    executablePath: "/opt/nap/host.mjs",
    readyTimeoutMs: 30,
  });
  const found = await host.start(request, async () => {});
  if (!found.ok) throw new Error("start failed");
  expect(await found.value.write("hello")).toMatchObject({ ok: false });
  const count = f.sent.length;
  expect(await found.value.renew()).toMatchObject({ ok: false });
  expect(await found.value.write("never replay")).toMatchObject({ ok: false });
  expect(f.sent).toHaveLength(count);
  expect(await found.value.closed).toMatchObject({
    ok: false,
    error: { code: "delivery_uncertain" },
  });
});

it("uses only the attached sandbox commands without reconnecting or changing its timeout", async () => {
  const handle = {
    pid: 42,
    sendStdin: async () => {},
    wait: async () => ({ exitCode: 0 }),
    disconnect: async () => {},
  };
  const commands = { run: vi.fn(async () => handle), connect: vi.fn(async () => handle) };
  const client = attachedE2BProcessClient({ sandboxId: "already-created", commands });
  const output = async () => {};
  expect(await client.start("already-created", "/opt/nap/it's host.mjs", output)).toBe(handle);
  expect(commands.run).toHaveBeenCalledWith("node '/opt/nap/it'\\''s host.mjs'", {
    user: "root",
    envs: {},
    background: true,
    stdin: true,
    timeoutMs: 0,
    onStdout: output,
  });
  expect(await client.connect("already-created", 42, output)).toBe(handle);
  expect(commands.connect).toHaveBeenCalledWith(42, { timeoutMs: 0, onStdout: output });
  await expect(client.start("another-sandbox", "/opt/nap/host.mjs", output)).rejects.toThrow(
    "does not match",
  );
  await expect(client.connect("another-sandbox", 42, output)).rejects.toThrow("does not match");
  expect(commands.run).toHaveBeenCalledOnce();
  expect(commands.connect).toHaveBeenCalledOnce();
});

it("preserves a late physical receipt after persistence fails, without acknowledging failed output", async () => {
  const f = fixture();
  const accept = vi.fn(async () => {
    throw new Error("private persistence failure");
  });
  const started = await f.host.start(request, accept);
  if (!started.ok) throw new Error("No fixture start");
  await f.emit({ type: "output", seq: 1, stream: "stdout", data: "eA==" });
  expect(await started.value.closed).toMatchObject({
    ok: false,
    error: { code: "persistence_failed" },
  });
  expect((await started.value.write("refused")).ok).toBe(false);
  await f.emit({ type: "exit", seq: 2, code: null, reason: "stopped", containment: "cgroup" });
  expect(await started.value.termination).toMatchObject({
    ok: true,
    value: { containment: "cgroup" },
  });
  expect(accept).toHaveBeenCalledOnce();
  expect(f.sent.some((frame) => NativeHostCommandSchema.parse(frame).type === "ack")).toBe(false);
});

it("bounds missing physical proof after persistence failure", async () => {
  const f = fixture();
  const host = new E2BProcessHost({
    client: f.client,
    executablePath: "/fixture/host",
    readyTimeoutMs: 20,
  });
  const started = await host.start(request, async () => {
    throw new Error("fixture");
  });
  if (!started.ok) throw new Error("No fixture start");
  await f.emit({ type: "output", seq: 1, stream: "stdout", data: "eA==" });
  expect(await started.value.termination).toMatchObject({ ok: false });
  expect(f.disconnects()).toBe(1);
});
