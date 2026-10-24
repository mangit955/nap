import { randomUUID } from "node:crypto";
import type { ProjectComputerAccess } from "@nap/shared/ports/project-computer-access";
import { eq, sql as sqlOf } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { PostgresProjectComputerAccess } from "./postgres-project-computer-access.ts";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { projects, sessions, turnRequests, users } from "./schema.ts";
import { enqueueRequest } from "./testing/enqueue-request.ts";

// Claims scan the whole queue, so this file owns turn_requests while it runs. The db project
// serializes files. Independent pools keep the driver from serializing the races for us.
let client: postgres.Sql;
let inputClient: postgres.Sql;
let db: PostgresJsDatabase;
let access: ProjectComputerAccess;
let queue: PostgresTurnQueue;
const inputApplication = `computer-input-${randomUUID()}`;

beforeAll(() => {
  // Bound broken-lock mutations so test barriers still unwind through finally.
  client = postgres(inject("postgresUrl"), { max: 8, connection: { lock_timeout: 2_000 } });
  inputClient = postgres(inject("postgresUrl"), {
    max: 1,
    connection: { application_name: inputApplication, lock_timeout: 2_000 },
  });
  db = drizzle(client);
  queue = new PostgresTurnQueue(db);
  access = new PostgresProjectComputerAccess(drizzle(inputClient));
});

beforeEach(async () => {
  await db.delete(turnRequests);
});

afterAll(async () => {
  await Promise.all([client.end(), inputClient.end()]);
});

function barrier() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function seed(sandboxId: string | null = "sandbox-current") {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user!.id, name: "Computer", slug: randomUUID(), sandboxId })
    .returning();
  const [session] = await db
    .insert(sessions)
    .values({ projectId: project!.id, title: "one" })
    .returning();
  return { projectId: project!.id, userId: user!.id, sessionId: session!.id };
}

async function enqueue(seed: { sessionId: string; userId: string }) {
  return enqueueRequest(queue, {
    ...seed,
    kind: "turn",
    message: "build",
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
}

async function revision(projectId: string) {
  const [row] = await db
    .select({ revision: projects.computerRevision })
    .from(projects)
    .where(eq(projects.id, projectId));
  return row!.revision;
}

async function assertUnlocked(projectId: string) {
  // NOWAIT checks the resource itself rather than inferring release from a callback's output.
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update", { noWait: true });
  });
  const transactions = await client`
    select state from pg_stat_activity
    where application_name = ${inputApplication} and state like 'idle in transaction%'
  `;
  expect(transactions).toHaveLength(0);
}

it("returns the callback value with authoritative sandbox and JSON-safe revision, including no sessions", async () => {
  const owner = await seed(null);
  await db.delete(sessions).where(eq(sessions.id, owner.sessionId));
  const before = await revision(owner.projectId);
  expect(before).toMatch(/^[0-9a-f-]{36}$/);
  const operation = vi.fn<Parameters<ProjectComputerAccess["withIdleProject"]>[1]>(
    async (computer) => ({ ...computer, action: "applied" }),
  );
  expect(await access.withIdleProject(owner, operation)).toStrictEqual({
    ok: true,
    value: { sandboxId: null, revision: before, action: "applied" },
  });
  await db
    .update(projects)
    .set({ sandboxId: "sandbox-replaced" })
    .where(eq(projects.id, owner.projectId));
  const result = await access.withIdleProject(owner, async (computer) => computer);
  expect(result).toStrictEqual({
    ok: true,
    value: { sandboxId: "sandbox-replaced", revision: before },
  });
  expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  expect(await revision(owner.projectId)).toBe(before);
  await assertUnlocked(owner.projectId);
});

it("hides missing projects and wrong ownership without calling the operation or leaking locks", async () => {
  const owner = await seed();
  const operation = vi.fn(async () => "never");
  for (const request of [
    { ...owner, userId: randomUUID() },
    { ...owner, projectId: randomUUID() },
  ]) {
    expect(await access.withIdleProject(request, operation)).toStrictEqual({
      ok: false,
      error: { code: "not_found" },
    });
  }
  expect(operation).not.toHaveBeenCalled();
  await assertUnlocked(owner.projectId);
  await enqueue(owner);
  expect(await queue.claim("after-denial")).not.toBeNull();
});

it("holds input across its full callback, excludes claims, and lets another project's queue claim", async () => {
  const owner = await seed();
  const other = await seed();
  const before = await revision(owner.projectId);
  const request = await enqueue(owner);
  await db
    .update(turnRequests)
    .set({ createdAt: sqlOf`now() - interval '1 minute'` })
    .where(eq(turnRequests.id, request.id));
  const elsewhere = await enqueue(other);
  const entered = barrier();
  const drain = barrier();
  const input = access.withIdleProject(owner, async (computer) => {
    expect(computer).toStrictEqual({ sandboxId: "sandbox-current", revision: before });
    entered.open();
    await drain.promise;
    return "input drained";
  });
  try {
    await Promise.race([
      entered.promise,
      input.then(() => {
        throw new Error("callback never entered");
      }),
    ]);
    await expect(
      db.transaction(async (tx) => {
        await tx
          .select()
          .from(projects)
          .where(eq(projects.id, owner.projectId))
          .for("update", { noWait: true });
      }),
    ).rejects.toMatchObject({ cause: { code: "55P03" } });
    expect((await queue.claim("elsewhere"))?.id).toBe(elsewhere.id);
    expect(await queue.claim("input-active")).toBeNull();
    expect(await revision(owner.projectId)).toBe(before);
    expect(await queue.anyLeased([owner.sessionId])).toBe(false);
  } finally {
    drain.open();
    await input;
  }
  expect(await input).toStrictEqual({ ok: true, value: "input drained" });
  expect((await queue.claim("after-drain"))?.id).toBe(request.id);
  expect(await revision(owner.projectId)).not.toBe(before);
});

it("denies input after a claim and invalidates old revisions even after that claim completes", async () => {
  const owner = await seed();
  const grant = await access.withIdleProject(owner, async (computer) => computer);
  expect(grant.ok).toBe(true);
  if (!grant.ok) throw new Error("expected idle project");
  const request = await enqueue(owner);
  expect((await queue.claim("worker"))?.id).toBe(request.id);
  const claimedRevision = await revision(owner.projectId);
  expect(claimedRevision).not.toBe(grant.value.revision);
  const operation = vi.fn(async () => "never");
  expect(await access.withIdleProject(owner, operation)).toStrictEqual({
    ok: false,
    error: { code: "busy" },
  });
  expect(operation).not.toHaveBeenCalled();
  await assertUnlocked(owner.projectId);
  expect(await queue.settle(request.id, "worker", "done")).toBe(true);
  expect(
    await access.withIdleProject(owner, async ({ revision }) => revision === grant.value.revision),
  ).toStrictEqual({ ok: true, value: false });
  expect(await revision(owner.projectId)).toBe(claimedRevision);
  expect(await queue.claim("empty")).toBeNull();
  expect(await revision(owner.projectId)).toBe(claimedRevision);
  await enqueue(owner);
  expect(await queue.claim("next")).not.toBeNull();
  expect(await revision(owner.projectId)).not.toBe(claimedRevision);
});

it("waits behind an uncommitted claim and denies input after the grant commits", async () => {
  const owner = await seed();
  const request = await enqueue(owner);
  const written = barrier();
  const commit = barrier();
  const claimingDb = drizzle(client);
  const transaction = claimingDb.transaction.bind(claimingDb);
  // Pause the actual claim transaction after its SQL, before Postgres commits. No query or
  // busy result is faked: pg_blocking_pids below must observe the input waiting on this lock.
  vi.spyOn(claimingDb, "transaction").mockImplementation((callback, config) =>
    transaction(async (tx) => {
      const result = await callback(tx);
      written.open();
      await commit.promise;
      return result;
    }, config),
  );
  const claiming = new PostgresTurnQueue(claimingDb).claim("claim-first");
  const operation = vi.fn(async () => "never");
  let input: ReturnType<ProjectComputerAccess["withIdleProject"]> | undefined;
  try {
    await Promise.race([
      written.promise,
      claiming.then(() => {
        throw new Error("claim did not reach commit barrier");
      }),
    ]);
    input = access.withIdleProject(owner, operation);
    await expect
      .poll(async () => {
        const rows = await client`
        select 1 from pg_stat_activity
        where application_name = ${inputApplication} and cardinality(pg_blocking_pids(pid)) > 0
      `;
        return rows.length;
      })
      .toBe(1);
    expect(operation).not.toHaveBeenCalled();
    expect(await queue.anyLeased([owner.sessionId])).toBe(false);
  } finally {
    commit.open();
    await claiming;
    await input;
  }
  expect((await claiming)?.id).toBe(request.id);
  expect(await input).toStrictEqual({ ok: false, error: { code: "busy" } });
  expect(operation).not.toHaveBeenCalled();
  await assertUnlocked(owner.projectId);
});

it("counts every project session and keeps an expired lease busy until orphaned", async () => {
  const owner = await seed();
  const [second] = await db
    .insert(sessions)
    .values({ projectId: owner.projectId, title: "two" })
    .returning();
  const request = await enqueue({ ...owner, sessionId: second!.id });
  expect(await access.withIdleProject(owner, async () => "queued is idle")).toStrictEqual({
    ok: true,
    value: "queued is idle",
  });
  expect((await queue.claim("worker"))?.id).toBe(request.id);
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sqlOf`now() - interval '1 hour'` })
    .where(eq(turnRequests.id, request.id));
  const operation = vi.fn(async () => "never");
  expect(await access.withIdleProject(owner, operation)).toStrictEqual({
    ok: false,
    error: { code: "busy" },
  });
  expect(operation).not.toHaveBeenCalled();
  await queue.orphanExpired();
  expect(await access.withIdleProject(owner, async () => "orphaned is idle")).toStrictEqual({
    ok: true,
    value: "orphaned is idle",
  });
  await assertUnlocked(owner.projectId);
});

it("keeps leases per session without holding the project guard across whole turns", async () => {
  const owner = await seed();
  const [second] = await db
    .insert(sessions)
    .values({ projectId: owner.projectId, title: "two" })
    .returning();
  const first = await enqueue(owner);
  const next = await enqueue({ ...owner, sessionId: second!.id });
  expect((await queue.claim("first"))?.id).toBe(first.id);
  const firstRevision = await revision(owner.projectId);
  expect((await queue.claim("second"))?.id).toBe(next.id);
  expect(await revision(owner.projectId)).not.toBe(firstRevision);
  expect(await queue.anyLeased([owner.sessionId])).toBe(true);
  expect(await queue.anyLeased([second!.id])).toBe(true);
  await queue.settle(first.id, "first", "done");
  expect(await access.withIdleProject(owner, async () => "never")).toStrictEqual({
    ok: false,
    error: { code: "busy" },
  });
  await queue.settle(next.id, "second", "done");
  expect(await access.withIdleProject(owner, async () => "both completed")).toStrictEqual({
    ok: true,
    value: "both completed",
  });
});

it("does not rotate revisions for empty or cancelled claim attempts", async () => {
  const owner = await seed();
  const other = await seed();
  const before = await revision(owner.projectId);
  expect(await revision(other.projectId)).not.toBe(before);
  expect(await queue.claim("empty")).toBeNull();
  await enqueue(owner);
  await queue.requestCancel(owner.sessionId);
  expect(await queue.claim("cancelled")).toBeNull();
  expect(await revision(owner.projectId)).toBe(before);
  await assertUnlocked(owner.projectId);
});

it("releases the transaction and propagates callback failures without detached promises", async () => {
  const owner = await seed();
  const before = await revision(owner.projectId);
  const request = await enqueue(owner);
  const entered = barrier();
  const drain = barrier();
  const failure = new Error("physical action failed");
  const input = access.withIdleProject(owner, async () => {
    entered.open();
    await drain.promise;
    throw failure;
  });
  // Attach rejection handling before releasing the callback, so the failure is never unhandled.
  const rejected = expect(input).rejects.toBe(failure);
  try {
    await entered.promise;
    expect(await queue.claim("before-failure")).toBeNull();
  } finally {
    drain.open();
    await rejected;
  }
  await assertUnlocked(owner.projectId);
  expect(await revision(owner.projectId)).toBe(before);
  expect((await queue.claim("after-failure"))?.id).toBe(request.id);
  await queue.settle(request.id, "after-failure", "done");
  expect(await access.withIdleProject(owner, async () => "next operation")).toStrictEqual({
    ok: true,
    value: "next operation",
  });
});

it("reads the sandbox after waiting for the project lock and holds it through the callback", async () => {
  const owner = await seed();
  const updated = barrier();
  const drain = barrier();
  const holding = db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({ sandboxId: "sandbox-new" })
      .where(eq(projects.id, owner.projectId));
    updated.open();
    await drain.promise;
  });
  const operation = vi.fn<Parameters<ProjectComputerAccess["withIdleProject"]>[1]>(
    async (computer) => computer,
  );
  let input: ReturnType<ProjectComputerAccess["withIdleProject"]> | undefined;
  try {
    await updated.promise;
    input = access.withIdleProject(owner, operation);
    await expect
      .poll(async () => {
        const rows = await client`
        select 1 from pg_stat_activity
        where application_name = ${inputApplication} and cardinality(pg_blocking_pids(pid)) > 0
      `;
        return rows.length;
      })
      .toBe(1);
    expect(operation).not.toHaveBeenCalled();
  } finally {
    drain.open();
    await holding;
    await input;
  }
  expect(await input).toStrictEqual({
    ok: true,
    value: { sandboxId: "sandbox-new", revision: await revision(owner.projectId) },
  });
  await assertUnlocked(owner.projectId);
});
