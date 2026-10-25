import { randomUUID } from "node:crypto";
import { PostgresProjectComputerAccess } from "@nap/db/postgres-project-computer-access";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { projectComputerOperations, projects, sessions, turnRequests, users } from "@nap/db/schema";
import { enqueueRequest } from "@nap/db/testing/enqueue-request";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { ProjectComputer } from "@nap/runtime/project-computer";
import { DesktopRequestSchema } from "@nap/sandbox/desktop-protocol";
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { ComputerControlGrantSchema } from "@nap/shared/computer-access";
import type { DesktopInputTransport } from "@nap/shared/ports/desktop-input-transport";
import { TURN_REQUEST_KINDS } from "@nap/shared/ports/turn-queue";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";

// These exercise HTTP composition against the real guard. Its separate-process races stay in DB.
let client: postgres.Sql;
let inputClient: postgres.Sql;
let db: PostgresJsDatabase;
let queue: PostgresTurnQueue;
const inputApplication = `owner-input-${randomUUID()}`;
beforeAll(() => {
  client = postgres(inject("postgresUrl"), { max: 4, connection: { lock_timeout: 2000 } });
  inputClient = postgres(inject("postgresUrl"), {
    max: 2,
    connection: { application_name: inputApplication, lock_timeout: 2000 },
  });
  db = drizzle(client);
  queue = new PostgresTurnQueue(db);
});
beforeEach(async () => {
  await db.delete(projectComputerOperations);
  await db.delete(turnRequests);
});
afterAll(async () => {
  try {
    // A deliberately terminated backend can leave postgres.js waiting for ReadyForQuery.
    await inputClient.end({ timeout: 1 });
    await vi.waitFor(
      async () => {
        const remaining = await client`
        select pid from pg_stat_activity where application_name = ${inputApplication}
      `;
        expect(remaining).toHaveLength(0);
      },
      { timeout: 2000 },
    );
  } finally {
    await client.end();
  }
});

async function fixture(transport?: DesktopInputTransport) {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@test.invalid`, name: "Owner" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user!.id, name: "Desktop", slug: randomUUID(), sandboxId: "box" })
    .returning();
  const [session, sibling] = await db
    .insert(sessions)
    .values([
      { projectId: project!.id, title: "current" },
      { projectId: project!.id, title: "older" },
    ])
    .returning();
  const desktop = new FakeSandboxDesktop({ bytes: new Uint8Array(), width: 1024, height: 768 });
  const guard = new PostgresProjectComputerAccess(drizzle(inputClient));
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId: user!.id, isAnonymous: false }),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(),
    },
    computerAccess: {
      sessions: new PostgresSessionStore(db),
      desktop,
      access: guard,
      computer: new ProjectComputer({ access: guard, transport: transport ?? desktop.transport }),
      secret: "integration-secret",
    },
  });
  const base = `/sessions/${session!.id}/computer`;
  const post = async (route: string, body: unknown = {}) =>
    app.request(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const grant = async () => {
    const response = await post("control");
    expect(response.status).toBe(200);
    return ComputerControlGrantSchema.parse(await response.json()).grant;
  };
  return {
    app,
    desktop,
    base,
    post,
    grant,
    projectId: project!.id,
    userId: user!.id,
    siblingId: sibling!.id,
  };
}

it("denies a sibling session's lease and keeps the old grant stale after that claim completes", async () => {
  const f = await fixture();
  const grant = await f.grant();
  const request = await enqueueRequest(queue, {
    sessionId: f.siblingId,
    userId: f.userId,
    kind: "turn",
    message: "build",
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
  // Queued work alone allows takeover.
  expect((await f.app.request(`${f.base}/control`)).status).toBe(200);
  expect((await queue.claim("worker"))?.id).toBe(request.id);
  for (const response of [
    await f.app.request(`${f.base}/control`),
    await f.post("control"),
    await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] }),
  ]) {
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "busy" });
  }
  expect(await queue.settle(request.id, "worker", "done")).toBe(true);
  const response = await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "stale_grant" });
  expect(f.desktop.actions).toEqual([]);
  await f.app.request(`${f.base}/stream`);
  expect(
    (
      await f.post("input", {
        grant: await f.grant(),
        actions: [{ action: "key", text: "Return" }],
      })
    ).status,
  ).toBe(200);
});

it("rejects a sandbox replacement using the locked row without relying on the revision", async () => {
  const f = await fixture();
  const grant = await f.grant();
  await db.update(projects).set({ sandboxId: "replacement" }).where(eq(projects.id, f.projectId));
  expect(
    (await f.post("input", { grant, actions: [{ action: "key", text: "Return" }] })).status,
  ).toBe(409);
  expect(f.desktop.actions).toEqual([]);
});

it("retains the committed fence after abort and ignores a late successful input reply", async () => {
  const f = await fixture();
  const grant = await f.grant();
  const abort = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
  let release = () => {};
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  vi.spyOn(f.desktop.transport, "act").mockImplementation(async () => {
    enter();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true, value: { kind: "none" } };
  });
  vi.spyOn(f.desktop.transport, "closeAndDrain").mockResolvedValue({
    ok: false,
    error: { code: "timeout", message: "No drain proof." },
  });
  const input = f.post("input", {
    grant,
    actions: [{ action: "left_click", coordinate: [10, 20] }],
  });
  try {
    await entered;
    const visible = await db
      .select()
      .from(projectComputerOperations)
      .where(eq(projectComputerOperations.projectId, f.projectId));
    expect(visible).toHaveLength(1);
    abort.abort();
    expect((await input).status).toBe(503);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      await db
        .select()
        .from(projectComputerOperations)
        .where(eq(projectComputerOperations.projectId, f.projectId)),
    ).toHaveLength(1);
    await enqueueRequest(queue, {
      sessionId: f.siblingId,
      userId: f.userId,
      kind: "turn",
      message: "build",
      model: "anthropic/claude-sonnet-5",
      billsToUser: false,
    });
    expect(await queue.claim("after-late-reply")).toBeNull();
  } finally {
    release();
    await input;
    timeout.mockRestore();
  }
});

function lostOutputDesktop() {
  const sandbox = new InMemorySandboxManager();
  // The command reached the transport, but its output is not a completion certificate.
  // Exercise the real adapter's output parser; no fake activity flag can grant drain.
  const exec = vi.spyOn(sandbox, "exec").mockResolvedValue({
    ok: true,
    value: { exitCode: 0, stdout: "{truncated", stderr: "" },
  });
  return {
    desktop: new E2BSandboxDesktop({ sandbox }),
    exec,
    actDispatches: () =>
      exec.mock.calls.filter((call) => {
        const encoded = call[1].match(/'([A-Za-z0-9+/=]+)'$/)?.[1];
        return (
          encoded &&
          DesktopRequestSchema.parse(JSON.parse(Buffer.from(encoded, "base64").toString())).op ===
            "act"
        );
      }).length,
  };
}

it("commits input admission before dispatch instead of holding a transaction across the RPC", async () => {
  const transport = lostOutputDesktop();
  const f = await fixture(transport.desktop);
  const grant = await f.grant();
  let transactionsAtDispatch = -1;
  let projectUnlockedAtDispatch = false;
  const act = transport.desktop.act.bind(transport.desktop);
  vi.spyOn(transport.desktop, "act").mockImplementation(async (...args) => {
    const open = await client`
      select pid from pg_stat_activity
      where application_name = ${inputApplication} and xact_start is not null
    `;
    transactionsAtDispatch = open.length;
    projectUnlockedAtDispatch = await db
      .transaction(async (tx) => {
        await tx
          .select()
          .from(projects)
          .where(eq(projects.id, f.projectId))
          .for("update", { noWait: true });
      })
      .then(
        () => true,
        () => false,
      );
    return act(...args);
  });

  const response = await f.post("input", {
    grant,
    actions: [{ action: "left_click", coordinate: [10, 20] }],
  });
  expect(response.status).toBe(503);
  expect(transport.actDispatches()).toBe(1);
  expect(transactionsAtDispatch).toBe(0);
  expect(projectUnlockedAtDispatch).toBe(true);
});

it.each(TURN_REQUEST_KINDS)(
  "retains project exclusion for a sibling %s claim after physical input output is lost",
  async (kind) => {
    const transport = lostOutputDesktop();
    const f = await fixture(transport.desktop);
    const grant = await f.grant();
    const response = await f.post("input", {
      grant,
      actions: [{ action: "left_click", coordinate: [10, 20] }],
    });
    expect(response.status).toBe(503);
    expect(transport.actDispatches()).toBe(1);
    const queued = await enqueueRequest(queue, {
      sessionId: f.siblingId,
      userId: f.userId,
      kind,
      message: kind === "resume" ? null : kind === "test" ? randomUUID() : "build",
      model: "anthropic/claude-sonnet-5",
      billsToUser: false,
    });
    // A different pool/store represents the next process. A returned HTTP failure and
    // a released transaction are not permission for any project session to execute.
    const nextProcess = new PostgresTurnQueue(drizzle(client));
    expect(await nextProcess.claim("successor")).toBeNull();
    expect(
      await nextProcess.getStatus({
        id: queued.id,
        sessionId: f.siblingId,
        userId: f.userId,
      }),
    ).toMatchObject({ state: "queued" });
  },
);

it("reports recovery pending and refuses owner replay after output loss", async () => {
  const transport = lostOutputDesktop();
  const f = await fixture(transport.desktop);
  const grant = await f.grant();
  const body = { grant, actions: [{ action: "left_click", coordinate: [10, 20] }] };
  expect((await f.post("input", body)).status).toBe(503);
  const status = await f.app.request(`${f.base}/control`);
  const retry = await f.post("input", body);
  expect(transport.actDispatches()).toBe(1);
  expect(status.status).toBe(503);
  expect(await status.json()).toMatchObject({ code: "recovery_pending" });
  expect(retry.status).toBe(503);
  expect(await retry.json()).toMatchObject({ code: "recovery_pending", applied: 0 });
});

it("keeps admission fenced after the dispatching database session is terminated", async () => {
  const transport = lostOutputDesktop();
  const f = await fixture(transport.desktop);
  let dispatched = () => {};
  const terminatedBackends: boolean[] = [];
  const dispatchFinished = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const act = transport.desktop.act.bind(transport.desktop);
  vi.spyOn(transport.desktop, "act").mockImplementation(async (...args) => {
    // Terminate only this suite's input pool. This models loss of the DB session while
    // remote input has an uncertain outcome, without killing any shared test backend.
    try {
      const terminated = await client<{ terminated: boolean }[]>`
        select pg_terminate_backend(pid) as terminated from pg_stat_activity
        where application_name = ${inputApplication} and pid <> pg_backend_pid()
      `;
      terminatedBackends.push(...terminated.map((row) => row.terminated));
      return await act(...args);
    } finally {
      dispatched();
    }
  });
  expect(
    (
      await f.post("input", {
        grant: await f.grant(),
        actions: [{ action: "left_click", coordinate: [10, 20] }],
      })
    ).status,
  ).toBe(503);
  await dispatchFinished;
  expect(terminatedBackends.length).toBeGreaterThan(0);
  expect(terminatedBackends.every((terminated) => terminated)).toBe(true);
  expect(transport.actDispatches()).toBe(1);
  await enqueueRequest(queue, {
    sessionId: f.siblingId,
    userId: f.userId,
    kind: "turn",
    message: "build",
    model: "anthropic/claude-sonnet-5",
    billsToUser: false,
  });
  expect(await new PostgresTurnQueue(drizzle(client)).claim("after-api-db-loss")).toBeNull();
});
