import { randomUUID } from "node:crypto";
import { eq, sql as sqlOf } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { PostgresEventStore } from "./postgres-event-store.ts";
import { PostgresNativeRunStore } from "./postgres-native-run-store.ts";
import { PostgresProviderAccountStore } from "./postgres-provider-account-store.ts";
import { nativeRuns, projects, sessions, turnRequests, users } from "./schema.ts";

let sql: postgres.Sql;
let db: PostgresJsDatabase;
beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 12 });
  db = drizzle(sql);
});
afterAll(async () => {
  await sql.end();
});

async function fixture() {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada", isAnonymous: false })
    .returning();
  if (!user) throw new Error("Missing fixture user");
  const [project] = await db
    .insert(projects)
    .values({ userId: user.id, name: "Native fixture", slug: randomUUID() })
    .returning();
  if (!project) throw new Error("Missing fixture project");
  const [session] = await db
    .insert(sessions)
    .values({ projectId: project.id, title: "Native fixture" })
    .returning();
  if (!session) throw new Error("Missing fixture session");
  const accounts = new PostgresProviderAccountStore(db);
  const account = await accounts.create({ userId: user.id, driver: "claude", label: "Work" });
  await accounts.completeSignIn(user.id, account.id, {
    generation: 0,
    credentials: { ciphertext: "sealed", iv: "iv" },
    identity: { email: null, plan: null },
  });
  const target = {
    kind: "subscription" as const,
    accountId: account.id,
    driver: "claude" as const,
    model: "native-fixture",
    generation: 1,
  };
  const requestId = randomUUID();
  const workerId = randomUUID();
  await db.insert(turnRequests).values({
    id: requestId,
    sessionId: session.id,
    userId: user.id,
    kind: "turn",
    state: "leased",
    target,
    message: "Edit",
    leaseOwner: workerId,
    leaseExpiresAt: new Date(Date.now() + 120_000),
  });
  const store = new PostgresNativeRunStore(db);
  const input = { id: randomUUID(), requestId, workerId, turnId: randomUUID() };
  const begun = await store.begin(input);
  if (begun.kind !== "created") throw new Error(`Could not begin fixture: ${begun.kind}`);
  const handle = begun.handle;
  const event = {
    type: "agent.message" as const,
    sessionId: session.id,
    turnId: input.turnId,
    createdAt: "2026-10-24T00:00:00.000Z",
    payload: { text: "Updated" },
  };
  const delivery = {
    sequence: 1,
    rawHash: "a".repeat(64),
    raw: { ciphertext: "sealed-native-frame", iv: "private-iv" },
    events: [event],
  };
  return {
    store,
    accounts,
    account,
    input,
    handle,
    target,
    binding: begun.binding,
    session,
    project,
    user,
    delivery,
  };
}

it("journals one start intent and refuses automatic replay after restart", async () => {
  const f = await fixture();
  expect(await new PostgresNativeRunStore(db).begin(f.input)).toEqual({ kind: "already_exists" });
  expect(await f.store.read(f.handle)).toEqual({ phase: "intent", cursor: 0, binding: f.binding });
  expect(
    await f.store.started(f.handle, {
      nativeSessionId: "native-session",
      receipt: { ciphertext: "sealed-reference", iv: "iv" },
    }),
  ).toBe(true);
  expect(await f.store.read(f.handle)).toMatchObject({
    phase: "started",
    nativeSessionId: "native-session",
  });
});

it("commits raw output, event identities and cursor atomically and deduplicates lost ACKs", async () => {
  const f = await fixture();
  await f.store.started(f.handle, {
    nativeSessionId: "native",
    receipt: { ciphertext: "reference", iv: "iv" },
  });
  const [first, second] = await Promise.all([
    f.store.append(f.handle, f.delivery),
    f.store.append(f.handle, {
      ...f.delivery,
      raw: { ciphertext: "fresh-encryption-same-bytes", iv: "new-iv" },
    }),
  ]);
  expect([first.kind, second.kind].sort()).toEqual(["appended", "duplicate"]);
  const events = await new PostgresEventStore(db).readFrom(f.session.id, 0);
  expect(events).toEqual([{ ...f.delivery.events[0], seq: 1 }]);
  expect(await f.store.read(f.handle)).toMatchObject({ cursor: 1 });
  expect(await f.store.deliveries(f.handle, 0)).toEqual([{ ...f.delivery, events }]);
  expect(await f.store.append(f.handle, { ...f.delivery, rawHash: "b".repeat(64) })).toEqual({
    kind: "conflict",
  });
  expect(await f.store.append(f.handle, { ...f.delivery, sequence: 3 })).toEqual({
    kind: "out_of_order",
  });
});

it("refuses foreign capabilities, expired queue leases and changed account generations", async () => {
  const f = await fixture();
  const reference = { nativeSessionId: "native", receipt: { ciphertext: "reference", iv: "iv" } };
  const foreign = { ...f.handle, token: "0".repeat(64) };
  expect(await f.store.read(foreign)).toBeNull();
  expect(await f.store.started(foreign, reference)).toBe(false);
  expect(await f.store.begin({ ...f.input, id: randomUUID(), workerId: "other-worker" })).toEqual({
    kind: "denied",
  });
  expect(await f.store.started(f.handle, reference)).toBe(true);
  expect(
    await f.store.append(f.handle, {
      ...f.delivery,
      events: [{ ...f.delivery.events[0]!, turnId: randomUUID() }],
    }),
  ).toEqual({ kind: "denied" });
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sqlOf`clock_timestamp() - interval '1 second'` })
    .where(eq(turnRequests.id, f.input.requestId));
  expect(await f.store.append(f.handle, f.delivery)).toEqual({ kind: "denied" });
  await db
    .update(turnRequests)
    .set({ leaseExpiresAt: sqlOf`clock_timestamp() + interval '1 minute'` })
    .where(eq(turnRequests.id, f.input.requestId));
  await f.accounts.revokeAuthorization(f.user.id, f.account.id);
  expect(await f.store.append(f.handle, f.delivery)).toEqual({ kind: "denied" });
  expect(await f.store.read(f.handle)).toBeNull();
  // Losing authority must not prevent a supervisor from recording verified termination.
  const proof = {
    kind: "exit" as const,
    sequence: 2,
    code: null,
    reason: "stopped" as const,
    containment: "cgroup" as const,
  };
  expect(await f.store.stopped(f.handle, { ...proof, containment: "process_group" })).toBe(false);
  expect(await f.store.stopped(foreign, proof)).toBe(false);
  expect(await f.store.stopped(f.handle, proof)).toBe(true);
  expect(await f.store.stopped(f.handle, proof)).toBe(true);
});

it("keeps uncertain starts fenced after account deletion and does not accept a guessed receipt", async () => {
  const f = await fixture();
  expect(await f.store.begin({ ...f.input, id: randomUUID(), turnId: randomUUID() })).toEqual({
    kind: "busy",
  });
  expect(await f.store.uncertain(f.handle)).toBe(true);
  expect(await f.store.read(f.handle)).toMatchObject({ phase: "start_uncertain" });
  expect(
    await f.store.started(f.handle, {
      nativeSessionId: "guessed",
      receipt: { ciphertext: "unverified", iv: "iv" },
    }),
  ).toBe(false);
  await f.accounts.remove(f.user.id, f.account.id);
  const next = await f.accounts.create({ userId: f.user.id, driver: "claude", label: "New" });
  await f.accounts.completeSignIn(f.user.id, next.id, {
    generation: 0,
    credentials: { ciphertext: "sealed", iv: "iv" },
    identity: { email: null, plan: null },
  });
  await db
    .update(turnRequests)
    .set({ target: { ...f.target, accountId: next.id } })
    .where(eq(turnRequests.id, f.input.requestId));
  expect(await f.store.begin({ ...f.input, id: randomUUID(), turnId: randomUUID() })).toEqual({
    kind: "busy",
  });
  expect(
    await f.store.stopped(f.handle, {
      kind: "exit",
      sequence: 1,
      code: null,
      reason: "stopped",
      containment: "cgroup",
    }),
  ).toBe(true);
  expect(await f.store.begin({ ...f.input, id: randomUUID(), turnId: randomUUID() })).toMatchObject(
    { kind: "created" },
  );
});

it("retains a partial raw frame with no public events so reconnect can rebuild the decoder", async () => {
  const f = await fixture();
  await f.store.started(f.handle, {
    nativeSessionId: "native",
    receipt: { ciphertext: "reference", iv: "iv" },
  });
  expect(await f.store.append(f.handle, { ...f.delivery, events: [] })).toMatchObject({
    kind: "appended",
    delivery: { events: [] },
  });
  expect(await f.store.read(f.handle)).toMatchObject({ cursor: 1 });
  expect(await f.store.append(f.handle, { ...f.delivery, sequence: 2 })).toMatchObject({
    kind: "appended",
    delivery: { events: [{ seq: 1 }] },
  });
  expect(await f.store.deliveries(f.handle, 0)).toHaveLength(2);
  expect(await f.store.deliveries(f.handle, 1)).toMatchObject([{ sequence: 2 }]);
  expect(await f.store.deliveries(f.handle, 3)).toBeNull();
});

it("rolls back public events when persisting their native delivery receipt fails", async () => {
  const f = await fixture();
  await f.store.started(f.handle, {
    nativeSessionId: "native",
    receipt: { ciphertext: "reference", iv: "iv" },
  });
  const name = `native_fault_${randomUUID().replaceAll("-", "")}`;
  const identifier = sqlOf.identifier(name);
  await db.execute(
    sqlOf`create function ${identifier}() returns trigger language plpgsql as $$ begin if NEW.raw_hash = repeat('f', 64) then raise exception 'injected native receipt failure'; end if; return NEW; end $$`,
  );
  await db.execute(
    sqlOf`create trigger ${identifier} before insert on native_deliveries for each row execute function ${identifier}()`,
  );
  try {
    await expect(
      f.store.append(f.handle, { ...f.delivery, rawHash: "f".repeat(64) }),
    ).rejects.toThrow();
    expect(await new PostgresEventStore(db).readFrom(f.session.id, 0)).toEqual([]);
    expect(await f.store.read(f.handle)).toMatchObject({ cursor: 0 });
    expect(await f.store.deliveries(f.handle, 0)).toEqual([]);
  } finally {
    await db.execute(sqlOf`drop trigger ${identifier} on native_deliveries`);
    await db.execute(sqlOf`drop function ${identifier}()`);
  }
  expect(await f.store.append(f.handle, f.delivery)).toMatchObject({
    kind: "appended",
    delivery: { events: [{ seq: 1 }] },
  });
});

it("refuses delivery if the durable request no longer names the binding's exact target", async () => {
  const f = await fixture();
  await f.store.started(f.handle, {
    nativeSessionId: "native",
    receipt: { ciphertext: "reference", iv: "iv" },
  });
  await db
    .update(turnRequests)
    .set({ target: { ...f.target, model: "another-model" } })
    .where(eq(turnRequests.id, f.input.requestId));
  expect(await f.store.append(f.handle, f.delivery)).toEqual({ kind: "denied" });
});

it("refuses more output before inserting events when the journal's storage budget is exhausted", async () => {
  const f = await fixture();
  await f.store.started(f.handle, {
    nativeSessionId: "native",
    receipt: { ciphertext: "reference", iv: "iv" },
  });
  await db
    .update(nativeRuns)
    .set({ deliveryBytes: 67_108_864 })
    .where(eq(nativeRuns.id, f.handle.id));
  expect(await f.store.append(f.handle, f.delivery)).toEqual({ kind: "limit_exceeded" });
  expect(await new PostgresEventStore(db).readFrom(f.session.id, 0)).toEqual([]);
  expect(await f.store.read(f.handle)).toMatchObject({ cursor: 0 });
});

it("fences a fresh login even when the account still reports authenticated", async () => {
  const f = await fixture();
  await f.store.started(f.handle, {
    nativeSessionId: "native",
    receipt: { ciphertext: "reference", iv: "iv" },
  });
  await f.accounts.completeSignIn(f.user.id, f.account.id, {
    generation: 1,
    credentials: { ciphertext: "new-login", iv: "iv" },
    identity: { email: null, plan: null },
  });
  expect(await f.store.append(f.handle, f.delivery)).toEqual({ kind: "denied" });
});

it("serializes native runs across projects sharing an account and accounts sharing a project", async () => {
  const f = await fixture();
  // The native fence must survive the queue lease that originally admitted it.
  await db
    .update(turnRequests)
    .set({ state: "failed", finishedAt: new Date() })
    .where(eq(turnRequests.id, f.input.requestId));
  const otherAccount = await f.accounts.create({
    userId: f.user.id,
    driver: "claude",
    label: "Personal",
  });
  await f.accounts.completeSignIn(f.user.id, otherAccount.id, {
    generation: 0,
    credentials: { ciphertext: "other", iv: "iv" },
    identity: { email: null, plan: null },
  });
  const [otherProject] = await db
    .insert(projects)
    .values({ userId: f.user.id, name: "Other", slug: randomUUID() })
    .returning();
  if (!otherProject) throw new Error("Missing second project");
  for (const [projectId, target] of [
    [f.project.id, { ...f.target, accountId: otherAccount.id }],
    [otherProject.id, f.target],
  ] as const) {
    const [session] = await db
      .insert(sessions)
      .values({ projectId, title: "Concurrent" })
      .returning();
    if (!session) throw new Error("Missing concurrent session");
    const requestId = randomUUID();
    await db.insert(turnRequests).values({
      id: requestId,
      sessionId: session.id,
      userId: f.user.id,
      kind: "turn",
      state: "leased",
      target,
      message: "Concurrent",
      leaseOwner: f.input.workerId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      await f.store.begin({ ...f.input, id: randomUUID(), requestId, turnId: randomUUID() }),
    ).toEqual({ kind: "busy" });
  }
});
