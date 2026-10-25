import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { NativeWorkspaceReplySchema } from "@nap/shared/ports/native-workspace-tools";
import type { SandboxProcessHost } from "@nap/shared/ports/sandbox-process";
import { expect, it, vi } from "vitest";
import { NativeWorkspaceGateway } from "./native-workspace-gateway.ts";

async function fixture() {
  const sandbox = new InMemorySandboxManager({ seed: { "/home/user/app/a.txt": "old" } });
  const created = await sandbox.create("project");
  if (!created.ok) throw new Error("fixture sandbox failed");
  const events = new InMemoryEventStore();
  let allowed = true;
  const start = vi.fn<SandboxProcessHost["start"]>(async () => ({
    ok: false,
    error: { code: "start_uncertain", message: "Missing process receipt" },
  }));
  const gateway = new NativeWorkspaceGateway({
    sessionId: "session",
    turnId: "turn",
    sandboxId: created.value.id,
    sandbox,
    host: {
      start,
      connect: async () => ({ ok: false, error: { code: "unavailable", message: "unused" } }),
    },
    authorize: async () => allowed,
    events,
    publish: async () => {},
  });
  return {
    gateway,
    sandbox,
    sandboxId: created.value.id,
    events,
    start,
    revoke: () => {
      allowed = false;
    },
  };
}
it("makes the tool intent durable before mutating a file and refuses duplicate call execution", async () => {
  const f = await fixture();
  const original = f.sandbox.writeFile.bind(f.sandbox);
  let writes = 0;
  vi.spyOn(f.sandbox, "writeFile").mockImplementation(async (...args) => {
    writes++;
    expect((await f.events.readFrom("session", 0)).at(-1)?.type).toBe("tool.call");
    return original(...args);
  });
  const call = {
    id: "a".repeat(64),
    tool: "write_file" as const,
    input: { path: "/home/user/app/a.txt", contents: "new" },
  };
  expect(await f.gateway.execute(call, new AbortController().signal)).toMatchObject({
    ok: true,
    value: { ok: true },
  });
  expect((await f.events.readFrom("session", 0)).map((event) => event.type)).toEqual([
    "tool.call",
    "file.changed",
    "tool.result",
  ]);
  expect(await f.gateway.execute(call, new AbortController().signal)).toMatchObject({
    ok: false,
    error: { code: "denied" },
  });
  expect(writes).toBe(1);
  expect(await f.gateway.stop()).toEqual([]);
});
it("revokes file and command access when its run loses authorization", async () => {
  const f = await fixture();
  f.revoke();
  expect(
    await f.gateway.execute(
      {
        id: "b".repeat(64),
        tool: "write_file",
        input: { path: "/home/user/app/a.txt", contents: "bad" },
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "denied" } });
  expect(await f.sandbox.readFile(f.sandboxId, "/home/user/app/a.txt")).toMatchObject({
    ok: true,
    value: "old",
  });
  expect(f.start).not.toHaveBeenCalled();
});
it("keeps the write barrier unconfirmed after an ambiguous command start", async () => {
  const f = await fixture();
  expect(
    await f.gateway.execute(
      { id: "c".repeat(64), tool: "run_command", input: { command: "pwd" } },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: { code: "execution_uncertain" } });
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(await f.gateway.stop()).toBeNull();
});
it("never dispatches shell commands through the aggregate, unsupervised sandbox exec method", async () => {
  const f = await fixture();
  const exec = vi.spyOn(f.sandbox, "exec");
  await f.gateway.execute(
    { id: "d".repeat(64), tool: "run_command", input: { command: "pwd" } },
    new AbortController().signal,
  );
  expect(exec).not.toHaveBeenCalled();
  expect(f.start).toHaveBeenCalledWith(
    expect.objectContaining({ executable: "/bin/sh", sandboxId: f.sandboxId, leaseMs: 5000 }),
    expect.any(Function),
  );
});

it("claims a tool id before awaiting authorization so concurrent delivery cannot write twice", async () => {
  const f = await fixture();
  const write = vi.spyOn(f.sandbox, "writeFile");
  const call = {
    id: "e".repeat(64),
    tool: "write_file" as const,
    input: { path: "/home/user/app/a.txt", contents: "new" },
  };
  const result = await Promise.all([
    f.gateway.execute(call, new AbortController().signal),
    f.gateway.execute(call, new AbortController().signal),
  ]);
  expect(result.filter((reply) => reply.ok)).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(1);
});
it("does not claim filesystem quiescence after an ambiguous remote write response", async () => {
  const f = await fixture();
  vi.spyOn(f.sandbox, "writeFile").mockResolvedValue({
    ok: false,
    error: { code: "timeout", message: "private transport error" },
  });
  const result = await f.gateway.execute(
    {
      id: "f".repeat(64),
      tool: "write_file",
      input: { path: "/home/user/app/a.txt", contents: "new" },
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: false, error: { code: "execution_uncertain" } });
  expect(await f.gateway.stop()).toBeNull();
  expect(JSON.stringify(await f.events.readFrom("session", 0))).not.toContain(
    "private transport error",
  );
});

it("streams supervised UTF-8 output durably and returns its cgroup proof to the workspace barrier", async () => {
  const f = await fixture();
  const proof = {
    kind: "exit" as const,
    sequence: 3,
    code: 0,
    reason: "exited" as const,
    containment: "cgroup" as const,
  };
  f.start.mockImplementation(async (_request, accept) => {
    let finish: (
      value: Awaited<import("@nap/shared/ports/sandbox-process").SandboxProcess["closed"]>,
    ) => void = () => {};
    const closed = new Promise<
      Awaited<import("@nap/shared/ports/sandbox-process").SandboxProcess["closed"]>
    >((resolve) => {
      finish = resolve;
    });
    queueMicrotask(() => {
      void (async () => {
        const bytes = new TextEncoder().encode("héllo\n");
        await accept({ kind: "output", sequence: 1, stream: "stdout", data: bytes.slice(0, 2) });
        expect((await f.events.readFrom("session", 0)).at(-1)?.type).toBe("command.output");
        await accept({ kind: "output", sequence: 2, stream: "stdout", data: bytes.slice(2) });
        await accept(proof);
        finish({ ok: true, value: proof });
      })();
    });
    const success = async () => ({ ok: true as const, value: undefined });
    return {
      ok: true,
      value: {
        reference: {
          sandboxId: f.sandboxId,
          pid: 10,
          token: "a".repeat(64),
          containment: "cgroup",
        },
        closed,
        write: success,
        renew: success,
        stop: success,
        interrupt: success,
        disconnect: success,
        resize: success,
      },
    };
  });
  const exec = vi.spyOn(f.sandbox, "exec");
  expect(
    await f.gateway.execute(
      { id: "1".repeat(64), tool: "run_command", input: { command: "pwd" } },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true, value: { output: "exit code 0\nhéllo\n" } });
  expect(exec).not.toHaveBeenCalled();
  expect(await f.gateway.stop()).toEqual([proof]);
  expect((await f.events.readFrom("session", 0)).map((event) => event.type)).toEqual([
    "tool.call",
    "command.output",
    "command.output",
    "tool.result",
  ]);
});

it("waits for the durable tool intent acknowledgement before any file effect", async () => {
  const f = await fixture();
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const append = f.events.append.bind(f.events);
  vi.spyOn(f.events, "append").mockImplementation(async (event, options) => {
    if (event.type === "tool.call") {
      entered();
      await gate;
    }
    return append(event, options);
  });
  const write = vi.spyOn(f.sandbox, "writeFile");
  const running = f.gateway.execute(
    {
      id: "2".repeat(64),
      tool: "write_file",
      input: { path: "/home/user/app/a.txt", contents: "new" },
    },
    new AbortController().signal,
  );
  await waiting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prematureWrites = write.mock.calls.length;
  release();
  expect(await running).toMatchObject({ ok: true });
  expect(prematureWrites).toBe(0);
});

it("fits oversized producer output including its truncation suffix in the native reply contract", async () => {
  const f = await fixture();
  await f.sandbox.writeFile(f.sandboxId, "/home/user/app/large.txt", "x".repeat(60_000));
  const reply = await f.gateway.execute(
    { id: "f".repeat(64), tool: "read_file", input: { path: "/home/user/app/large.txt" } },
    new AbortController().signal,
  );
  expect(reply).toMatchObject({ ok: true, value: { ok: true } });
  if (!reply.ok) throw new Error("Fixture read failed");
  expect(reply.value.output).toContain("truncated");
  expect(reply.value.output.length).toBeLessThanOrEqual(30_000);
  expect(NativeWorkspaceReplySchema.safeParse(reply).success).toBe(true);
  expect(await f.gateway.stop()).toEqual([]);
});
