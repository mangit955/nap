import { createHash } from "node:crypto";
import { ClaudeNativeHelper } from "@nap/agent/claude-native-helper";
import type { ClaudeQueryFactory } from "@nap/agent/claude-native-session";
import { ClaudeNativeCommandSchema } from "@nap/agent/claude-native-wire";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { encodeNativeFrame, NativeFrameDecoder } from "@nap/shared/native-process-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type {
  NativeRunRecord,
  NativeRunStore,
  StoredNativeDelivery,
} from "@nap/shared/ports/native-run-store";
import type { NativeStateCipher } from "@nap/shared/ports/native-state-cipher";
import type { NativeExecutionInput } from "@nap/shared/ports/native-turn-executor";
import type { SandboxProcess, SandboxProcessHost } from "@nap/shared/ports/sandbox-process";
import { expect, it, vi } from "vitest";
import { type ClaudeExecutionEnvironment, ClaudeNativeExecutor } from "./claude-native-executor.ts";

const input: NativeExecutionInput = {
  userId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  turnId: "00000000-0000-4000-8000-000000000004",
  sandboxId: "project-sandbox",
  lease: { requestId: "00000000-0000-4000-8000-000000000005", workerId: "worker" },
  target: {
    kind: "subscription",
    accountId: "00000000-0000-4000-8000-000000000006",
    driver: "claude",
    generation: 1,
    model: "native",
  },
  input: { trustedInstructions: "Nap instructions", prompt: "Build a page" },
};
it("refuses an unavailable isolated runtime before requesting a native start, without executing an API model", async () => {
  const f = fixture();
  const executor = new ClaudeNativeExecutor({ resolve: async () => null, store: f.store, cipher });
  const result = await executor.run(input, { publish: async () => {} });
  expect(result).toMatchObject({ kind: "failed", quiescence: { kind: "not_started" } });
  expect(f.store.begin).not.toHaveBeenCalled();
});

const sessionId = "00000000-0000-4000-8000-000000000007";
const cipher: NativeStateCipher = {
  seal: (scope, value) => ({
    ciphertext: Buffer.from(value).toString("base64"),
    iv: createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
  }),
  open: (scope, value) =>
    value.iv === createHash("sha256").update(JSON.stringify(scope)).digest("hex")
      ? { ok: true, value: Buffer.from(value.ciphertext, "base64").toString() }
      : { ok: false, reason: "scope_mismatch" },
};
function fixture(eventStore = new InMemoryEventStore()) {
  let binding = {
    userId: input.userId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.lease.requestId,
    turnId: input.turnId,
    target: input.target,
  };
  let record: NativeRunRecord = { binding, cursor: 0, phase: "intent" };
  const deliveries: StoredNativeDelivery[] = [];
  const events: StoredEvent[] = [];
  const published: StoredEvent[] = [];
  const order: string[] = [];
  const prompts: unknown[] = [];
  let allow = true;
  const handle = { id: "00000000-0000-4000-8000-000000000008", token: "b".repeat(64) };
  const store = {
    begin: vi.fn<NativeRunStore["begin"]>(async (request) => {
      handle.id = request.id;
      order.push("intent");
      return { kind: "created", handle, binding };
    }),
    started: vi.fn<NativeRunStore["started"]>(async (_handle, value) => {
      order.push("receipt");
      record = { binding, cursor: 0, phase: "started", ...value };
      return true;
    }),
    uncertain: vi.fn<NativeRunStore["uncertain"]>(async () => {
      record = { binding, cursor: record.cursor, phase: "start_uncertain" };
      return true;
    }),
    read: vi.fn<NativeRunStore["read"]>(async () => (allow ? structuredClone(record) : null)),
    deliveries: vi.fn<NativeRunStore["deliveries"]>(async () => structuredClone(deliveries)),
    append: vi.fn<NativeRunStore["append"]>(async (_handle, frame) => {
      if (!allow) return { kind: "denied" };
      const stored: StoredEvent[] = [];
      for (const event of frame.events) stored.push(await eventStore.append(event));
      events.push(...stored);
      record.cursor = frame.sequence;
      const delivery = { ...frame, events: stored };
      deliveries.push(delivery);
      return { kind: "appended", delivery };
    }),
    stopped: vi.fn<NativeRunStore["stopped"]>(async (_handle, proof) => {
      order.push("fence_released");
      record = { binding, cursor: record.cursor, phase: "stopped", proof };
      return true;
    }),
  } satisfies NativeRunStore;
  let query: ClaudeQueryFactory = (request) => ({
    initializationResult: async () => ({
      account: { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "oauth" },
    }),
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for await (const _prompt of request.prompt) {
        prompts.push(_prompt.message.content);
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", source: "sdk", status: "connected" }],
        };
        yield {
          type: "assistant",
          session_id: sessionId,
          message: { id: "message-1", content: [{ type: "text", text: "Built" }] },
        };
        yield {
          type: "result",
          session_id: sessionId,
          subtype: "success",
          is_error: false,
          usage: { input_tokens: 2, output_tokens: 3 },
        };
      }
    },
  });
  let proofContainment: "cgroup" | "process_group" = "cgroup";
  let loseStart = false;
  const host: SandboxProcessHost = {
    connect: vi.fn<SandboxProcessHost["connect"]>(async () => ({
      ok: false,
      error: { code: "unavailable", message: "Not used" },
    })),
    start: vi.fn<SandboxProcessHost["start"]>(async (_launch, accept) => {
      order.push("process_start");
      if (loseStart)
        return { ok: false, error: { code: "start_uncertain", message: "Lost receipt" } };
      let sequence = 0;
      let resolve: (result: Awaited<SandboxProcess["closed"]>) => void = () => {};
      const closed = new Promise<Awaited<SandboxProcess["closed"]>>((done) => {
        resolve = done;
      });
      const helper = new ClaudeNativeHelper({
        query: (value) => query(value),
        write: async (frame) => {
          await accept({
            kind: "output",
            stream: "stdout",
            sequence: ++sequence,
            data: new TextEncoder().encode(encodeNativeFrame(frame)),
          });
        },
      });
      void helper.closed.then(async () => {
        const proof = {
          kind: "exit" as const,
          sequence: ++sequence,
          code: 0,
          reason: "exited" as const,
          containment: proofContainment,
        };
        try {
          await accept(proof);
          order.push("agent_stopped");
          resolve({ ok: true, value: proof });
        } catch {
          resolve({
            ok: false,
            error: { code: "persistence_failed", message: "Missing durable receipt" },
          });
        }
      });
      const decoder = new NativeFrameDecoder(ClaudeNativeCommandSchema, 4 * 1024 * 1024);
      return {
        ok: true,
        value: {
          reference: {
            sandboxId: "private-auth-sandbox",
            pid: 10,
            token: "a".repeat(64),
            containment: "cgroup",
          },
          closed,
          write: async (data) => {
            for (const command of decoder.push(new TextEncoder().encode(data))) {
              if (command.type === "start") order.push("prompt");
              await helper.accept(command);
            }
            return { ok: true, value: undefined };
          },
          renew: async () => {
            order.push("renew");
            return { ok: true, value: undefined };
          },
          stop: async () => {
            helper.stop();
            return { ok: true, value: undefined };
          },
          interrupt: async () => {
            helper.stop();
            return { ok: true, value: undefined };
          },
          disconnect: async () => ({ ok: true, value: undefined }),
          resize: async () => ({ ok: true, value: undefined }),
        },
      };
    }),
  };
  const environment: ClaudeExecutionEnvironment = {
    userId: input.userId,
    projectId: input.projectId,
    target: input.target,
    sandboxId: "private-auth-sandbox",
    nodeExecutable: "/usr/bin/node",
    host,
    config: {
      sessionId,
      cwd: "/home/user/native",
      home: "/home/user",
      configDir: "/home/user/.claude",
      executablePath: "/opt/claude/claude",
      environment: { PATH: "/usr/bin:/bin" },
    },
    workspace: {
      execute: vi.fn<ClaudeExecutionEnvironment["workspace"]["execute"]>(async () => ({
        ok: true,
        value: { ok: true, output: "Done" },
      })),
      stop: vi.fn<ClaudeExecutionEnvironment["workspace"]["stop"]>(async () => {
        order.push("writers_stopped");
        return [];
      }),
    },
  };
  let onResolve = (_request: NativeExecutionInput) => {};
  const executor = new ClaudeNativeExecutor({
    resolve: async (request) => {
      binding = {
        userId: request.userId,
        projectId: request.projectId,
        sessionId: request.sessionId,
        requestId: request.lease.requestId,
        turnId: request.turnId,
        target: request.target,
      };
      record = { binding, phase: "intent", cursor: 0 };
      deliveries.length = 0;
      onResolve(request);
      return environment;
    },
    store,
    cipher,
  });
  return {
    executor,
    environment,
    store,
    events,
    published,
    order,
    deliveries,
    prompts,
    run: (request = input) =>
      executor.run(request, {
        publish: async (event) => {
          published.push(event);
        },
      }),
    setResolve: (value: (request: NativeExecutionInput) => void) => {
      onResolve = value;
    },
    setQuery: (value: ClaudeQueryFactory) => {
      query = value;
    },
    loseStart: () => {
      loseStart = true;
    },
    revoke: () => {
      allow = false;
    },
    weakenProof: () => {
      proofContainment = "process_group";
    },
  };
}
it("persists native start before offering the prompt and releases its fence only after both write barriers", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    kind: "completed",
    usage: { inputTokens: 2, outputTokens: 3 },
    quiescence: { kind: "confirmed" },
  });
  expect(f.order.indexOf("intent")).toBeLessThan(f.order.indexOf("process_start"));
  expect(f.order.indexOf("receipt")).toBeLessThan(f.order.indexOf("prompt"));
  expect(f.order.indexOf("agent_stopped")).toBeLessThan(f.order.indexOf("fence_released"));
  expect(f.order.indexOf("writers_stopped")).toBeLessThan(f.order.indexOf("fence_released"));
  expect(f.published).toEqual(f.events);
  expect(f.events).toMatchObject([{ type: "agent.message", payload: { text: "Built" } }]);
  expect(f.deliveries.length).toBeGreaterThan(f.events.length);
});
it("does not replay an ambiguous native start or release its durable fence", async () => {
  const f = fixture();
  f.loseStart();
  expect(await f.run()).toMatchObject({ kind: "failed", quiescence: { kind: "unconfirmed" } });
  expect(f.environment.host.start).toHaveBeenCalledTimes(1);
  expect(f.store.uncertain).toHaveBeenCalledTimes(1);
  expect(f.store.stopped).not.toHaveBeenCalled();
});
it("rejects an auth runtime sharing the project's sandbox before any process or journal start", async () => {
  const f = fixture();
  f.environment.sandboxId = input.sandboxId;
  expect(await f.run()).toMatchObject({ kind: "failed", quiescence: { kind: "not_started" } });
  expect(f.environment.host.start).not.toHaveBeenCalled();
  expect(f.store.begin).not.toHaveBeenCalled();
});
it("does not release a native fence for a process-group termination receipt", async () => {
  const f = fixture();
  f.weakenProof();
  expect(await f.run()).toMatchObject({ kind: "failed", quiescence: { kind: "unconfirmed" } });
  expect(f.store.stopped).not.toHaveBeenCalled();
});

it.each(["", "x"])(
  "preserves Unicode when private input exceeds one host frame: %s",
  async (prefix) => {
    const f = fixture();
    const prompt = prefix + "😀".repeat(40000);
    expect(await f.run({ ...input, input: { ...input.input, prompt } })).toMatchObject({
      kind: "completed",
    });
    expect(f.prompts).toEqual([prompt]);
  },
);
it("keeps the native fence if the workspace writer barrier cannot be proved", async () => {
  const f = fixture();
  f.environment.workspace.stop = async () => null;
  expect(await f.run()).toMatchObject({ kind: "failed", quiescence: { kind: "unconfirmed" } });
  expect(f.store.stopped).not.toHaveBeenCalled();
});
it("sends no prompt when native receipt persistence fails", async () => {
  const f = fixture();
  f.store.started.mockResolvedValue(false);
  expect(await f.run()).toMatchObject({ kind: "failed", quiescence: { kind: "unconfirmed" } });
  expect(f.order).not.toContain("prompt");
  expect(f.store.stopped).not.toHaveBeenCalled();
});
it("does not acknowledge or complete after durable output persistence fails", async () => {
  const f = fixture();
  f.store.append.mockRejectedValue(new Error("private database failure"));
  expect(await f.run()).toMatchObject({ kind: "failed", quiescence: { kind: "unconfirmed" } });
  expect(f.published).toEqual([]);
  expect(f.store.stopped).not.toHaveBeenCalled();
});

it("stops renewing a revoked account and retains the fence when its final delivery is no longer authorized", async () => {
  const f = fixture();
  let waiting = () => {};
  const ready = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  f.setQuery((request) => ({
    initializationResult: async () => ({
      account: { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "oauth" },
    }),
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for await (const _prompt of request.prompt) {
        yield {
          type: "system",
          subtype: "init",
          session_id: sessionId,
          apiKeySource: "none",
          tools: [],
          mcp_servers: [{ name: "nap", source: "sdk", status: "connected" }],
        };
        waiting();
        await new Promise<void>(() => {});
      }
    },
  }));
  const running = f.run();
  await ready;
  f.revoke();
  expect(await running).toMatchObject({ kind: "failed", quiescence: { kind: "unconfirmed" } });
  expect(f.order).not.toContain("renew");
  expect(f.order).toContain("writers_stopped");
  expect(f.store.stopped).not.toHaveBeenCalled();
});

it("runs a native MCP edit, commits it, repairs the failed check and commits the repair through Nap's outer runtime", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { NativeAgentService } = await import("@nap/agent/native-agent-service");
  const { InMemorySandboxManager } = await import("@nap/sandbox/testing/in-memory-sandbox-manager");
  const { scriptGit, FAKE_COMMIT_SHA } = await import("@nap/sandbox/testing/script-git");
  const { InMemorySessionStore } = await import("@nap/db/testing/in-memory-session-store");
  const { InMemoryEventBus } = await import("@nap/db/testing/in-memory-event-bus");
  const { NoopMemoryProvider } = await import("@nap/context/noop-memory-provider");
  const { StubContextEngine } = await import("@nap/context/testing/stub-context-engine");
  const { SingleAgentRuntime } = await import("./single-agent-runtime.ts");
  const { NativeWorkspaceGateway } = await import("./native-workspace-gateway.ts");
  const sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [5173],
      defaultExec: () => ({ exitCode: 0 }),
      seed: {
        "/home/user/app/package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }),
      },
    }),
  );
  const created = await sandbox.create(input.projectId);
  if (!created.ok) throw new Error("Fixture project failed");
  let valid = false;
  sandbox.script(/bun run typecheck/, () =>
    valid ? { exitCode: 0 } : { exitCode: 2, stderr: "TS2304: missing symbol" },
  );
  const originalWrite = sandbox.writeFile.bind(sandbox);
  vi.spyOn(sandbox, "writeFile").mockImplementation(async (id, path, contents) => {
    if (path.endsWith("App.tsx")) valid = contents === "export const good = true;";
    return originalWrite(id, path, contents);
  });
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  const f = fixture(events);
  const requests: NativeExecutionInput[] = [];
  f.setResolve((request) => {
    requests.push(request);
    f.environment.workspace = new NativeWorkspaceGateway({
      sessionId: request.sessionId,
      turnId: request.turnId,
      sandboxId: request.sandboxId,
      sandbox,
      host: {
        start: async () => ({
          ok: false,
          error: { code: "unavailable", message: "This fixture edits files only" },
        }),
        connect: async () => ({ ok: false, error: { code: "unavailable", message: "unused" } }),
      },
      authorize: async () => true,
      events,
      publish: async (event) => {
        bus.publish(event);
      },
    });
  });
  let queries = 0;
  f.setQuery((request) => {
    const index = ++queries;
    return {
      initializationResult: async () => ({
        account: { apiProvider: "firstParty", apiKeySource: "none", tokenSource: "oauth" },
      }),
      interrupt: async () => {},
      close: () => {},
      async *[Symbol.asyncIterator]() {
        for await (const _prompt of request.prompt) {
          yield {
            type: "system",
            subtype: "init",
            session_id: sessionId,
            apiKeySource: "none",
            tools: [],
            mcp_servers: [{ name: "nap", source: "sdk", status: "connected" }],
          };
          const server = request.options.mcpServers?.nap;
          if (server?.type !== "sdk") throw new Error("Missing native MCP server");
          const client = new Client({ name: "offline-repair-proof", version: "1.0.0" });
          const [left, right] = InMemoryTransport.createLinkedPair();
          await server.instance.connect(right);
          await client.connect(left);
          try {
            const result = await client.callTool({
              name: "write_file",
              arguments: {
                path: "/home/user/app/App.tsx",
                contents: index === 1 ? "export const bad = missing;" : "export const good = true;",
              },
            });
            expect(result.isError).toBe(false);
          } finally {
            await client.close();
            await server.instance.close();
          }
          yield {
            type: "assistant",
            session_id: sessionId,
            message: {
              id: `message-${index}`,
              content: [{ type: "text", text: "Updated the file" }],
            },
          };
          yield { type: "result", session_id: sessionId, subtype: "success", is_error: false };
        }
      },
    };
  });
  const context = new StubContextEngine();
  const api = { runTurn: vi.fn(async () => {}) };
  const runtime = new SingleAgentRuntime({
    sessions: new InMemorySessionStore([
      {
        sessionId: input.sessionId,
        projectId: input.projectId,
        userId: input.userId,
        sandboxId: created.value.id,
      },
    ]),
    sandbox,
    context,
    events,
    bus,
    memory: new NoopMemoryProvider(),
    agent: new NativeAgentService({ api, executor: f.executor }),
  });
  const outcome = await runtime.runTurn({
    sessionId: input.sessionId,
    turnId: input.turnId,
    message: "Build the page",
    target: input.target,
    nativeLease: input.lease,
  });
  expect(outcome).toMatchObject({ ok: true, commitSha: FAKE_COMMIT_SHA });
  expect(queries).toBe(2);
  expect(
    requests.every((request) => JSON.stringify(request.target) === JSON.stringify(input.target)),
  ).toBe(true);
  expect(requests[1]?.input.prompt).toContain("TS2304");
  expect(context.requests).toHaveLength(0);
  expect(api.runTurn).not.toHaveBeenCalled();
  expect(await sandbox.readFile(created.value.id, "/home/user/app/App.tsx")).toMatchObject({
    ok: true,
    value: "export const good = true;",
  });
  const logged = await events.readFrom(input.sessionId, 0);
  expect(logged.filter((event) => event.type === "tool.call")).toHaveLength(2);
  expect(logged.filter((event) => event.type === "file.changed")).toHaveLength(2);
  expect(logged.filter((event) => event.type === "turn.completed")).toHaveLength(2);
  expect(
    sandbox.commands(created.value.id).filter((command) => command.includes("commit -m")),
  ).toHaveLength(2);
});
