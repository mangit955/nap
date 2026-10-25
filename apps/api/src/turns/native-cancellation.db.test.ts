import { randomUUID } from "node:crypto";
import { ClaudeNativeCommandSchema } from "@nap/agent/claude-native-wire";
import { NativeAgentService } from "@nap/agent/native-agent-service";
import { PostgresNativeRunStore } from "@nap/db/postgres-native-run-store";
import { PostgresProviderAccountStore } from "@nap/db/postgres-provider-account-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { nativeRuns, projects, sessions, turnRequests, users } from "@nap/db/schema";
import { ClaudeNativeExecutor } from "@nap/runtime/claude-native-executor";
import { E2BProcessHost } from "@nap/sandbox/e2b-process-host";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import {
  encodeNativeFrame,
  NativeFrameDecoder,
  NativeHostCommandSchema,
} from "@nap/shared/native-process-protocol";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { NativeStateCipher } from "@nap/shared/ports/native-state-cipher";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it, vi } from "vitest";

let sql: postgres.Sql;
beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

it.each([true, false])(
  "records physical stop after ordinary queue cancellation; known writers=%s never authorizes finalization",
  async (knownWriters) => {
    const db = drizzle(sql);
    const [user] = await db
      .insert(users)
      .values({
        email: `${randomUUID()}@example.com`,
        name: "Cancelled native fixture",
        isAnonymous: false,
      })
      .returning();
    if (!user) throw new Error("Missing user");
    const [project] = await db
      .insert(projects)
      .values({ userId: user.id, name: "Cancelled native", slug: randomUUID() })
      .returning();
    if (!project) throw new Error("Missing project");
    const [session] = await db
      .insert(sessions)
      .values({ projectId: project.id, title: "Cancelled native" })
      .returning();
    if (!session) throw new Error("Missing session");
    const accounts = new PostgresProviderAccountStore(db);
    const account = await accounts.create({ userId: user.id, driver: "claude", label: null });
    await accounts.completeSignIn(user.id, account.id, {
      generation: 0,
      credentials: { ciphertext: "fixture", iv: "fixture" },
      identity: { email: "verified@example.com", plan: null },
    });
    const target = {
      kind: "subscription",
      accountId: account.id,
      driver: "claude",
      model: "native-fixture",
      generation: 1,
    } as const;
    const queue = new PostgresTurnQueue(db);
    const requestId = randomUUID();
    const workerId = randomUUID();
    // Claim selects globally from the shared database; seed only this fixture's lease.
    await db.insert(turnRequests).values({
      id: requestId,
      sessionId: session.id,
      userId: user.id,
      kind: "turn",
      state: "leased",
      message: "Fixture",
      target,
      leaseOwner: workerId,
      leaseExpiresAt: new Date(Date.now() + 120_000),
    });
    const store = new PostgresNativeRunStore(db);
    const append = vi.spyOn(store, "append");
    const stopped = vi.spyOn(store, "stopped");
    const controller = new AbortController();
    const nativeSessionId = randomUUID();
    let output: (text: string) => Promise<void> = async () => {};
    let sequence = 0;
    let ended = false;
    const pending: Promise<void>[] = [];
    let promptStarted = () => {};
    const prompt = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const emit = (value: unknown) => output(encodeNativeFrame(value));
    const commands = new NativeFrameDecoder(ClaudeNativeCommandSchema, 4 * 1024 * 1024);
    const host = new E2BProcessHost({
      executablePath: "/fixture/host",
      client: {
        start: async (_sandbox, _path, accept) => {
          output = accept;
          return {
            pid: 42,
            sendStdin: async (line) => {
              const frame = NativeHostCommandSchema.parse(JSON.parse(line));
              if (frame.type === "start")
                await emit({ type: "ready", pid: 100, containment: "cgroup" });
              if (frame.type === "input")
                for (const command of commands.push(Buffer.from(frame.data)))
                  if (command.type === "start") promptStarted();
              if (frame.type === "stop" && !ended) {
                ended = true;
                pending.push(
                  emit({
                    type: "exit",
                    seq: ++sequence,
                    code: null,
                    reason: "stopped",
                    containment: "cgroup",
                  }),
                );
              }
            },
            wait: () => new Promise<{ exitCode: number }>(() => {}),
            disconnect: async () => {},
          };
        },
        connect: async () => {
          throw new Error("Unexpected reconnect");
        },
      },
    });
    const cipher: NativeStateCipher = {
      seal: (scope, text) => ({
        ciphertext: Buffer.from(text).toString("base64"),
        iv: JSON.stringify(scope),
      }),
      open: (scope, value) =>
        value.iv === JSON.stringify(scope)
          ? { ok: true, value: Buffer.from(value.ciphertext, "base64").toString() }
          : { ok: false, reason: "scope_mismatch" },
    };
    const executor = new ClaudeNativeExecutor({
      store,
      cipher,
      resolve: async () => ({
        userId: user.id,
        projectId: project.id,
        target,
        sandboxId: "private-auth",
        nodeExecutable: "/fixture/node",
        host,
        config: {
          sessionId: nativeSessionId,
          cwd: "/private",
          home: "/private",
          configDir: "/private/.claude",
          executablePath: "/fixture/claude",
          environment: {},
        },
        workspace: { execute: vi.fn(), stop: async () => (knownWriters ? [] : null) },
      }),
    });
    const events: PendingEvent[] = [];
    const finalize = vi.fn(async () => ({ commitSha: "must-not-finalize" }));
    const api = { runTurn: vi.fn(async () => {}) };
    const service = new NativeAgentService({ api, executor });
    const running = service.runTurn({
      kind: "native",
      target,
      userId: user.id,
      projectId: project.id,
      sessionId: session.id,
      turnId: requestId,
      sandboxId: "project",
      lease: { requestId, workerId },
      input: { prompt: "Fixture", trustedInstructions: "Fixture" },
      sandbox: new InMemorySandboxManager(),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
      },
      onStoredEvent: () => {},
      drain: async () => {},
      finalize,
    });
    await prompt;
    expect(await queue.requestCancel(session.id)).toEqual({ cancelled: true, was: "leased" });
    expect(await queue.renew(requestId, workerId)).toMatchObject({
      held: true,
      cancelRequested: true,
    });
    // Force the ordinary final delivery through the real store after authority was withdrawn.
    await emit({
      type: "output",
      seq: ++sequence,
      stream: "stdout",
      data: Buffer.from(
        encodeNativeFrame({
          type: "message",
          message: { type: "system", session_id: nativeSessionId },
        }),
      ).toString("base64"),
    });
    controller.abort();
    await running;
    await Promise.allSettled(pending);
    expect(append).toHaveBeenCalled();
    expect(await append.mock.results[0]?.value).toMatchObject({ kind: "denied" });
    expect(finalize).not.toHaveBeenCalled();
    expect(api.runTurn).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).not.toContain("turn.completed");
    expect(events.at(-1)?.type).toBe("turn.failed");
    expect(stopped).toHaveBeenCalledTimes(knownWriters ? 1 : 0);
    const [record] = await db.select().from(nativeRuns).where(eq(nativeRuns.requestId, requestId));
    expect(record?.phase).toBe(knownWriters ? "stopped" : "started");
    await queue.settle(requestId, workerId, "failed");
    expect(await queue.isBusy([session.id])).toBe(!knownWriters);
  },
);
