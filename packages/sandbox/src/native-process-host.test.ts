import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  encodeNativeFrame,
  NativeFrameDecoder,
  type NativeHostEvent,
  NativeHostEventSchema,
  type NativeHostStart,
} from "@nap/shared/native-process-protocol";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const nativeGroups = new Set<number>();
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
  }
  for (const pid of nativeGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  nativeGroups.clear();
});

function host(
  program: string,
  options: {
    leaseMs?: number;
    maxOutputBytes?: number;
    containment?: NativeHostStart["containment"];
  } = {},
) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./native-process-host.ts", import.meta.url)),
  ]);
  children.push(child);
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const events: NativeHostEvent[] = [];
  let stderr = "";
  const decoder = new NativeFrameDecoder(NativeHostEventSchema, 1024 * 1024);
  child.stdout.on("data", (chunk: Buffer) => {
    const incoming = decoder.push(chunk);
    for (const event of incoming) if (event.type === "ready") nativeGroups.add(event.pid);
    events.push(...incoming);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = once(child, "close");
  child.stdin.write(
    encodeNativeFrame({
      type: "start",
      token,
      executable: process.execPath,
      args: ["-e", program],
      cwd: process.cwd(),
      env: {},
      leaseMs: options.leaseMs ?? 3000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      maxReplayBytes: 1024 * 1024,
      containment: options.containment ?? { kind: "process_group" },
    }),
  );
  return {
    events,
    child,
    token,
    send: (command: Record<string, unknown>) =>
      child.stdin.write(encodeNativeFrame({ ...command, token })),
    async waitFor(predicate: (event: NativeHostEvent) => boolean) {
      const deadline = Date.now() + 4000;
      while (!events.some(predicate)) {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Host exited: ${stderr}`);
        if (Date.now() >= deadline) throw new Error(`Host event timeout: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async finish() {
      await closed;
      decoder.finish();
      return { events, stderr };
    },
  };
}

const output = (events: NativeHostEvent[], stream: "stdout" | "stderr" = "stdout") =>
  events
    .filter((event) => event.type === "output" && event.stream === stream)
    .map((event) => (event.type === "output" ? Buffer.from(event.data, "base64").toString() : ""))
    .join("");

describe("supervised native processes", () => {
  it("streams both outputs, forwards stdin, and reports the real exit status", async () => {
    const run = host(
      'process.stdin.once("data", data => { process.stdout.write(data); process.stderr.write("diagnostic"); process.exitCode = 7; process.stdin.destroy(); });',
    );
    await run.waitFor((event) => event.type === "ready");
    run.send({ type: "input", data: "hello\n" });
    const result = await run.finish();
    expect(output(result.events)).toBe("hello\n");
    expect(output(result.events, "stderr")).toBe("diagnostic");
    expect(result.events.at(-1)).toMatchObject({ type: "exit", code: 7, reason: "exited" });
    expect(result.stderr).toBe("");
  });

  it("expires independently when the controller stops renewing its lease", async () => {
    const run = host("setInterval(() => {}, 1000)", { leaseMs: 100 });
    const { events } = await run.finish();
    expect(events.at(-1)).toMatchObject({
      type: "exit",
      reason: "lease_expired",
      containment: "process_group",
    });
  });

  it("rejects another controller's commands and does not echo its token", async () => {
    const run = host(
      'process.stdin.once("data", () => { console.log("accepted"); process.exit(); })',
    );
    await run.waitFor((event) => event.type === "ready");
    run.child.stdin.write(
      encodeNativeFrame({ type: "input", token: "b".repeat(64), data: "wrong" }),
    );
    const { events, stderr } = await run.finish();
    expect(output(events)).toBe("");
    expect(events.at(-1)).toMatchObject({ type: "exit", reason: "protocol_error" });
    expect(JSON.stringify(events) + stderr).not.toContain("b".repeat(64));
  });

  it("replays unacknowledged output without executing the child again", async () => {
    const run = host('console.log("once"); process.stdin.resume();');
    await run.waitFor((event) => event.type === "output");
    const first = run.events.find((event) => event.type === "output");
    run.send({ type: "replay", afterSequence: 0 });
    const deadline = Date.now() + 2000;
    while (
      run.events.filter((event) => event.type === "output").length < 2 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(run.events.filter((event) => event.type === "output")).toEqual([first, first]);
    run.send({ type: "stop" });
    expect((await run.finish()).events.at(-1)).toMatchObject({ type: "exit", reason: "stopped" });
  });

  it("bounds runaway output and terminates the process", async () => {
    const run = host('setInterval(() => process.stdout.write("x".repeat(4096)), 1)', {
      maxOutputBytes: 1000,
    });
    const { events } = await run.finish();
    expect(Buffer.byteLength(output(events))).toBeLessThanOrEqual(1000);
    expect(events.at(-1)).toMatchObject({ type: "exit", reason: "output_limit" });
  });

  it("stops on controller EOF rather than leaving an orphan", async () => {
    const run = host("setInterval(() => {}, 1000)");
    await run.waitFor((event) => event.type === "ready");
    run.child.stdin.end();
    expect((await run.finish()).events.at(-1)).toMatchObject({
      type: "exit",
      reason: "controller_closed",
    });
  });

  it("renews the host-side lease while a process is running", async () => {
    const run = host("process.stdin.resume();", { leaseMs: 250 });
    await run.waitFor((event) => event.type === "ready");
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      run.send({ type: "renew" });
    }
    expect(run.events.some((event) => event.type === "exit")).toBe(false);
    run.send({ type: "stop" });
    expect((await run.finish()).events.at(-1)).toMatchObject({ reason: "stopped" });
  });

  it("refuses replay older than the acknowledged cursor", async () => {
    const run = host('console.log("once"); process.stdin.resume();');
    await run.waitFor((event) => event.type === "output");
    const first = run.events.find((event) => event.type === "output");
    if (first?.type !== "output") throw new Error("missing output");
    run.send({ type: "ack", sequence: first.seq });
    run.send({ type: "replay", afterSequence: 0 });
    expect((await run.finish()).events.at(-1)).toMatchObject({ reason: "replay_unavailable" });
  });

  it("refuses unavailable cgroup containment before starting user code", async () => {
    const run = host('console.log("must not execute")', {
      containment: {
        kind: "cgroup",
        root: `/sys/fs/cgroup/missing-${crypto.randomUUID()}`,
        uid: 1000,
        gid: 1000,
      },
    });
    const { events } = await run.finish();
    expect(events.some((event) => event.type === "ready")).toBe(false);
    expect(output(events)).toBe("");
    expect(events.at(-1)).toMatchObject({
      reason: "containment_unavailable",
      containment: "unknown",
    });
  });

  it("does not misrepresent process-group termination as detached-child containment", async () => {
    const program =
      'const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); console.log(c.pid); c.unref(); process.stdin.resume();';
    const run = host(program);
    await run.waitFor((event) => event.type === "output");
    const detached = Number(output(run.events).trim());
    try {
      run.send({ type: "stop" });
      expect((await run.finish()).events.at(-1)).toMatchObject({ containment: "process_group" });
      expect(() => process.kill(detached, 0)).not.toThrow();
    } finally {
      try {
        process.kill(detached, "SIGKILL");
      } catch {}
    }
  });
});
