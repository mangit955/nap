import { randomUUID } from "node:crypto";
import type { ComputerReservationRequest } from "@nap/shared/ports/project-computer-access";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";
import { PostgresProjectComputerAccess } from "./postgres-project-computer-access.ts";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { projectComputerOperations, projects, sessions, turnRequests, users } from "./schema.ts";
import { enqueueRequest } from "./testing/enqueue-request.ts";

let client: postgres.Sql;
let inputClient: postgres.Sql;
let db: PostgresJsDatabase;
let access: PostgresProjectComputerAccess;
let queue: PostgresTurnQueue;
beforeAll(() => {
  client = postgres(inject("postgresUrl"), { max: 8, connection: { lock_timeout: 2000 } });
  inputClient = postgres(inject("postgresUrl"), { max: 2, connection: { lock_timeout: 2000 } });
  db = drizzle(client);
  access = new PostgresProjectComputerAccess(drizzle(inputClient));
  queue = new PostgresTurnQueue(db);
});
beforeEach(async () => {
  await db.delete(projectComputerOperations);
  await db.delete(turnRequests);
});
afterAll(async () => {
  await Promise.all([client.end(), inputClient.end()]);
});
async function seed() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.invalid`, name: "Owner" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user!.id, name: "Computer", slug: randomUUID(), sandboxId: "current" })
    .returning();
  const created = await db
    .insert(sessions)
    .values([
      { projectId: project!.id, title: "one" },
      { projectId: project!.id, title: "two" },
    ])
    .returning();
  return {
    projectId: project!.id,
    userId: user!.id,
    sessionId: created[0]!.id,
    siblingId: created[1]!.id,
  };
}
async function owner(f: Awaited<ReturnType<typeof seed>>): Promise<ComputerReservationRequest> {
  const state = await access.read(f);
  if (!state.ok) throw new Error("Expected idle project.");
  return {
    projectId: f.projectId,
    sandboxId: "current",
    scopeId: randomUUID(),
    actor: {
      kind: "owner",
      binding: {
        sandboxId: "current",
        revision: state.value.revision,
        expiresAt: Date.now() + 60_000,
        sessionId: f.sessionId,
        projectId: f.projectId,
        userId: f.userId,
      },
    },
  };
}
async function enqueue(f: Awaited<ReturnType<typeof seed>>, sessionId = f.sessionId) {
  return enqueueRequest(queue, {
    sessionId,
    userId: f.userId,
    kind: "turn",
    message: "build",
    model: "anthropic/claude-sonnet-5",
    billsToUser: false,
  });
}
const proof = (r: ComputerReservationRequest) => ({
  ...r,
  proof: {
    protocol: 2 as const,
    kind: "scope_drained" as const,
    scopeId: r.scopeId,
    sandboxId: r.sandboxId,
  },
});

it("returns authoritative state, including a null sandbox and a project without sessions", async () => {
  const f = await seed();
  await db.update(projects).set({ sandboxId: null }).where(eq(projects.id, f.projectId));
  await db.delete(sessions).where(eq(sessions.projectId, f.projectId));
  expect(await access.read(f)).toMatchObject({
    ok: true,
    value: { sandboxId: null, revision: expect.any(String) },
  });
});
it("hides wrong owners and missing projects", async () => {
  const f = await seed();
  expect(await access.read({ ...f, userId: randomUUID() })).toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });
  expect(await access.read({ ...f, projectId: randomUUID() })).toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });
});
it("commits a visible reservation and releases the row lock before returning", async () => {
  const f = await seed();
  const request = await owner(f);
  expect((await access.reserve(request)).ok).toBe(true);
  const rows = await db
    .select()
    .from(projectComputerOperations)
    .where(eq(projectComputerOperations.projectId, f.projectId));
  expect(rows[0]?.scopeId).toBe(request.scopeId);
  await db.transaction(async (tx) => {
    await tx
      .select()
      .from(projects)
      .where(eq(projects.id, f.projectId))
      .for("update", { noWait: true });
  });
  expect(await access.read(f)).toMatchObject({ ok: false, error: { code: "recovery_pending" } });
});
it("excludes every session of a fenced project while other projects continue claiming", async () => {
  const f = await seed();
  const other = await seed();
  const request = await owner(f);
  await access.reserve(request);
  await enqueue(f);
  await enqueue(f, f.siblingId);
  const elsewhere = await enqueue(other);
  expect((await queue.claim("elsewhere"))?.id).toBe(elsewhere.id);
  expect(await queue.claim("blocked")).toBeNull();
  expect(await queue.anyLeased([f.sessionId, f.siblingId])).toBe(false);
  expect(await access.clear(proof(request))).toBe(true);
  expect(await queue.claim("after-proof")).not.toBeNull();
});
it("denies existing sibling leases, including expired leases awaiting the janitor", async () => {
  const f = await seed();
  const grant = await owner(f);
  const queued = await enqueue(f, f.siblingId);
  await queue.claim("worker");
  const [current] = await db.select().from(projects).where(eq(projects.id, f.projectId));
  if (grant.actor.kind === "owner") grant.actor.binding.revision = current!.computerRevision;
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sql`now() - interval '1 hour'` })
    .where(eq(turnRequests.id, queued.id));
  expect(await access.reserve(grant)).toMatchObject({ ok: false, error: { code: "busy" } });
  await queue.orphanExpired();
  expect((await access.reserve(grant)).ok).toBe(true);
});
it("keeps source leases per session and validates the exact request/worker before model input", async () => {
  const f = await seed();
  const first = await enqueue(f);
  const second = await enqueue(f, f.siblingId);
  await queue.claim("one");
  await queue.claim("two");
  const request: ComputerReservationRequest = {
    projectId: f.projectId,
    sandboxId: "current",
    scopeId: randomUUID(),
    actor: { kind: "turn", lease: { requestId: first.id, owner: "one" } },
  };
  expect(await access.reserve(request)).toMatchObject({ ok: false, error: { code: "busy" } });
  await queue.settle(second.id, "two", "done");
  expect(
    await access.reserve({
      ...request,
      actor: { kind: "turn", lease: { requestId: randomUUID(), owner: "one" } },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await access.reserve({
      ...request,
      actor: { kind: "turn", lease: { requestId: first.id, owner: "wrong" } },
    }),
  ).toMatchObject({ ok: false });
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(turnRequests.id, first.id));
  expect(await access.reserve(request)).toMatchObject({ ok: false, error: { code: "busy" } });
  await db.update(turnRequests).set({ leaseExpiresAt: null }).where(eq(turnRequests.id, first.id));
  expect(await access.reserve(request)).toMatchObject({ ok: false, error: { code: "busy" } });
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sql`now() + interval '1 minute'`, cancelRequested: true })
    .where(eq(turnRequests.id, first.id));
  expect(await access.reserve(request)).toMatchObject({ ok: false, error: { code: "busy" } });
  expect(await access.occupied(f.projectId)).toBe(false);
  await db
    .update(turnRequests)
    .set({ cancelRequested: false })
    .where(eq(turnRequests.id, first.id));
  expect((await access.reserve(request)).ok).toBe(true);
});
it("competing owner reservations admit exactly one scope", async () => {
  const f = await seed();
  const request = await owner(f);
  const results = await Promise.all([
    access.reserve(request),
    new PostgresProjectComputerAccess(db).reserve({ ...request, scopeId: randomUUID() }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
});
it("matches sandbox, revision, expiry and owner-session bindings before reserving", async () => {
  const f = await seed();
  const request = await owner(f);
  if (request.actor.kind !== "owner") throw new Error("Expected owner.");
  for (const binding of [
    { ...request.actor.binding, sandboxId: "replacement" },
    { ...request.actor.binding, revision: randomUUID() },
    { ...request.actor.binding, expiresAt: 0 },
    { ...request.actor.binding, sessionId: randomUUID() },
  ])
    expect(await access.reserve({ ...request, actor: { kind: "owner", binding } })).toMatchObject({
      ok: false,
      error: { code: "stale_grant" },
    });
  expect(await access.occupied(f.projectId)).toBe(false);
});
it("only a matched certificate clears the row and old cleanup cannot clear a successor", async () => {
  const f = await seed();
  const request = await owner(f);
  await access.reserve(request);
  const wrong = proof(request);
  wrong.proof.scopeId = randomUUID();
  expect(await access.clear(wrong)).toBe(false);
  expect(await access.occupied(f.projectId)).toBe(true);
  expect(await access.clear(proof(request))).toBe(true);
  const successor = await owner(f);
  await access.reserve(successor);
  expect(await access.clear(proof(request))).toBe(false);
  expect(await access.occupied(f.projectId)).toBe(true);
});
it("never recovers a live claimed scope merely on age and fairly defers eligible rows", async () => {
  const f = await seed();
  const queued = await enqueue(f);
  await queue.claim("worker");
  const request: ComputerReservationRequest = {
    projectId: f.projectId,
    sandboxId: "current",
    scopeId: randomUUID(),
    actor: { kind: "turn", lease: { requestId: queued.id, owner: "worker" } },
  };
  await access.reserve(request);
  await db
    .update(projectComputerOperations)
    .set({ nextRecoveryAt: sql`now() - interval '1 hour'` });
  expect(await access.recoverable(1)).toEqual([]);
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sql`now() - interval '1 hour'` })
    .where(eq(turnRequests.id, queued.id));
  expect(await access.recoverable(1)).toEqual([]);
  await queue.orphanExpired();
  expect((await access.recoverable(1))[0]?.scopeId).toBe(request.scopeId);
  await access.defer(request);
  expect(await access.recoverable(1)).toEqual([]);
  expect(await access.occupied(f.projectId)).toBe(true);
});

// A reservation whose drain never arrives, as old as the abandon window demands.
async function stranded(f: Awaited<ReturnType<typeof seed>>, age = "6 minutes") {
  const request = await owner(f);
  expect((await access.reserve(request)).ok).toBe(true);
  await access.markRecovering(request);
  await db
    .update(projectComputerOperations)
    .set({ createdAt: sql`now() - ${age}::interval` })
    .where(eq(projectComputerOperations.projectId, f.projectId));
  return request;
}
const scope = (r: ComputerReservationRequest) => ({
  projectId: r.projectId,
  sandboxId: r.sandboxId,
  scopeId: r.scopeId,
});
it("reports the owner's held reservation and any lease, and hides it from everybody else", async () => {
  const f = await seed();
  expect(await access.held(f)).toEqual({ ok: true, value: { reservation: null, busy: false } });
  const request = await stranded(f);
  expect(await access.held(f)).toMatchObject({
    ok: true,
    value: { reservation: { scopeId: request.scopeId, state: "recovering" }, busy: false },
  });
  expect(await access.held({ ...f, userId: randomUUID() })).toEqual({
    ok: false,
    error: { code: "not_found" },
  });
});
it("abandons exactly the stranded scope, forgets its machine, and lets the project's claims run", async () => {
  const f = await seed();
  const request = await stranded(f);
  const queued = await enqueue(f);
  expect(await queue.claim("blocked")).toBeNull();
  const [before] = await db.select().from(projects).where(eq(projects.id, f.projectId));
  expect(await access.abandon({ ...scope(request), userId: f.userId })).toEqual({
    ok: true,
    value: undefined,
  });
  const [after] = await db.select().from(projects).where(eq(projects.id, f.projectId));
  expect(after).toMatchObject({ sandboxId: null, status: "idle" });
  expect(after!.computerRevision).not.toBe(before!.computerRevision);
  expect(await access.occupied(f.projectId)).toBe(false);
  expect((await queue.claim("after-abandon"))?.id).toBe(queued.id);
});
it("refuses to abandon early, under a lease, for a stranger, or for a scope that is not the held one", async () => {
  const f = await seed();
  const young = await stranded(f, "4 minutes");
  expect(await access.abandon({ ...scope(young), userId: f.userId })).toEqual({
    ok: false,
    error: { code: "too_early" },
  });
  await db
    .update(projectComputerOperations)
    .set({ createdAt: sql`now() - interval '6 minutes'` })
    .where(eq(projectComputerOperations.projectId, f.projectId));
  expect(await access.abandon({ ...scope(young), userId: randomUUID() })).toEqual({
    ok: false,
    error: { code: "not_found" },
  });
  expect(
    await access.abandon({ ...scope(young), scopeId: randomUUID(), userId: f.userId }),
  ).toEqual({ ok: false, error: { code: "stale_grant" } });
  expect(await access.occupied(f.projectId)).toBe(true);

  // A turn that still holds its lease owns its reservation; abandoning would pull its machine away.
  const g = await seed();
  const queued = await enqueue(g);
  await queue.claim("worker");
  const turn: ComputerReservationRequest = {
    projectId: g.projectId,
    sandboxId: "current",
    scopeId: randomUUID(),
    actor: { kind: "turn", lease: { requestId: queued.id, owner: "worker" } },
  };
  expect((await access.reserve(turn)).ok).toBe(true);
  await db
    .update(projectComputerOperations)
    .set({ createdAt: sql`now() - interval '6 minutes'` })
    .where(eq(projectComputerOperations.projectId, g.projectId));
  expect(await access.held(g)).toMatchObject({ ok: true, value: { busy: true } });
  expect(await access.abandon({ ...scope(turn), userId: g.userId })).toEqual({
    ok: false,
    error: { code: "busy" },
  });
  const [kept] = await db.select().from(projects).where(eq(projects.id, g.projectId));
  expect(kept?.sandboxId).toBe("current");
});
