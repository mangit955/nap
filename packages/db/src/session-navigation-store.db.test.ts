import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { projects, turnRequests, users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";
import { PostgresSessionNavigationStore } from "./session-navigation-store.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresSessionNavigationStore;
let owner: string;
beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 3 });
  db = drizzle(connection);
  store = new PostgresSessionNavigationStore(db);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Navigation owner" })
    .returning();
  owner = user?.id ?? "";
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await connection.end();
});
it("persists organization, refuses stale Undo and hides another owner's sessions", async () => {
  const created = await createProjectSession(db, { userId: owner, name: "Fix menu" });
  const page = await store.list(owner);
  const item = page.sessions.find((row) => row.projectId === created.projectId);
  if (!item) throw new Error("Missing session");
  expect(item.activity).toBe("ready");
  const pin = await store.change(owner, created.projectId, {
    revision: item.revision,
    change: { kind: "pin", pinned: true },
  });
  expect(pin.kind).toBe("saved");
  if (pin.kind !== "saved") throw new Error("Pin failed");
  expect(pin.navigation.pinned).toBe(true);
  expect(
    await store.change(owner, created.projectId, {
      revision: item.revision,
      change: { kind: "restore", navigation: item.navigation },
    }),
  ).toEqual({ kind: "conflict" });
  expect(
    await store.change(randomUUID(), created.projectId, {
      revision: pin.revision,
      change: { kind: "pin", pinned: false },
    }),
  ).toEqual({ kind: "missing" });
  expect((await store.list(randomUUID())).sessions).toEqual([]);
  expect(
    (await store.list(owner)).sessions.find((row) => row.projectId === created.projectId)
      ?.navigation.pinned,
  ).toBe(true);
});
it("refuses Done/archive while queued, and organization never releases the sandbox", async () => {
  const created = await createProjectSession(db, { userId: owner });
  await db
    .update(projects)
    .set({ sandboxId: "running-sandbox" })
    .where(eq(projects.id, created.projectId));
  const id = randomUUID();
  await db.insert(turnRequests).values({
    id,
    sessionId: created.sessionId,
    userId: owner,
    kind: "turn",
    message: "Work",
    model: "free",
  });
  const row = (await store.list(owner)).sessions.find(
    (entry) => entry.projectId === created.projectId,
  );
  expect(row?.activity).toBe("queued");
  for (const kind of ["done", "archive"] as const) {
    expect(
      await store.change(owner, created.projectId, { revision: 0, change: { kind, value: true } }),
    ).toEqual({ kind: "busy" });
  }
  await db
    .update(turnRequests)
    .set({ state: "done", finishedAt: new Date() })
    .where(eq(turnRequests.id, id));
  expect(
    (
      await store.change(owner, created.projectId, {
        revision: 0,
        change: { kind: "done", value: true },
      })
    ).kind,
  ).toBe("saved");
  const [project] = await db.select().from(projects).where(eq(projects.id, created.projectId));
  expect(project?.sandboxId).toBe("running-sandbox");
});
it("reorders atomically using every affected revision, with pagination independent of order", async () => {
  const a = await createProjectSession(db, { userId: owner, name: "A" });
  const b = await createProjectSession(db, { userId: owner, name: "B" });
  const rows = [
    { projectId: b.projectId, revision: 0 },
    { projectId: a.projectId, revision: 0 },
  ];
  expect((await store.reorder(owner, { section: "active", rows })).kind).toBe("saved");
  expect((await store.reorder(owner, { section: "active", rows })).kind).toBe("conflict");
  const all = await store.list(owner);
  expect(all.sessions.find((row) => row.projectId === b.projectId)?.navigation.position).toBe(0);
  expect(all.sessions.find((row) => row.projectId === a.projectId)?.navigation.position).toBe(1);
});

it("allows reordering a Done session reopened by a later request", async () => {
  const created = await createProjectSession(db, { userId: owner });
  await store.change(owner, created.projectId, {
    revision: 0,
    change: { kind: "done", value: true },
  });
  await db.insert(turnRequests).values({
    id: randomUUID(),
    sessionId: created.sessionId,
    userId: owner,
    kind: "turn",
    message: "Continue",
    model: "free",
    createdAt: new Date(Date.now() + 1000),
  });
  expect(
    await store.reorder(owner, {
      section: "active",
      rows: [{ projectId: created.projectId, revision: 1 }],
    }),
  ).toEqual({ kind: "saved" });
});

let nextSeq = 1;
async function event(
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  createdAt: Date,
): Promise<void> {
  await db.execute(sql`
    insert into events (session_id, turn_id, seq, type, payload, created_at)
    values (${sessionId}, ${randomUUID()}, ${nextSeq++}, ${type}, ${JSON.stringify(payload)}::jsonb, ${createdAt.toISOString()})
  `);
}
async function summary(projectId: string) {
  const row = (await store.list(owner)).sessions.find((entry) => entry.projectId === projectId);
  if (!row) throw new Error("Missing session");
  return row;
}
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
const completed = (commitSha: string | null, diff?: { added: number; removed: number }) => ({
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 1,
  commitSha,
  ...(diff ? { diff } : {}),
});

describe("the card's run start", () => {
  it("is null while a request waits, and the claim time once one runs", async () => {
    const created = await createProjectSession(db, { userId: owner });
    const id = randomUUID();
    await db.insert(turnRequests).values({
      id,
      sessionId: created.sessionId,
      userId: owner,
      kind: "turn",
      message: "Work",
      model: "free",
      createdAt: at(10),
    });
    const queued = await summary(created.projectId);
    expect(queued.activity).toBe("queued");
    expect(queued.requestedAt).not.toBeNull();
    expect(queued.runStartedAt).toBeNull();

    const claimed = at(3);
    await db
      .update(turnRequests)
      .set({ state: "leased", startedAt: claimed, leaseOwner: "worker" })
      .where(eq(turnRequests.id, id));
    const working = await summary(created.projectId);
    expect(working.activity).toBe("working");
    expect(working.runStartedAt).toBe(claimed.toISOString());

    await db
      .update(turnRequests)
      .set({ state: "done", finishedAt: new Date() })
      .where(eq(turnRequests.id, id));
    expect((await summary(created.projectId)).runStartedAt).toBeNull();
  });
});

describe("the card's finish time", () => {
  it("is the newest turn's end, unmoved by a later open or by nothing having finished", async () => {
    const created = await createProjectSession(db, { userId: owner });
    expect((await summary(created.projectId)).turnFinishedAt).toBeNull();
    const ended = at(20);
    await event(created.sessionId, "turn.completed", completed(null), ended);
    expect((await summary(created.projectId)).turnFinishedAt).toBe(ended.toISOString());

    // Opening a put-away project writes a newer request; the turn still ended when it ended.
    await db.insert(turnRequests).values({
      id: randomUUID(),
      sessionId: created.sessionId,
      userId: owner,
      kind: "resume",
      model: "free",
      state: "done",
      createdAt: at(5),
      startedAt: at(5),
      finishedAt: at(4),
    });
    expect((await summary(created.projectId)).turnFinishedAt).toBe(ended.toISOString());

    const failed = at(1);
    await event(created.sessionId, "turn.failed", { reason: "internal", message: "x" }, failed);
    expect((await summary(created.projectId)).turnFinishedAt).toBe(failed.toISOString());
  });
});

describe("the card's line counts", () => {
  it("come from the newest turn that committed, and are null when none counted", async () => {
    const created = await createProjectSession(db, { userId: owner });
    expect((await summary(created.projectId)).diff).toBeNull();
    // Recorded before line counts were: a commit, but nobody counted it.
    await event(created.sessionId, "turn.completed", completed("aaa1111"), at(30));
    expect((await summary(created.projectId)).diff).toBeNull();

    await event(
      created.sessionId,
      "turn.completed",
      completed("bbb2222", { added: 412, removed: 88 }),
      at(20),
    );
    expect((await summary(created.projectId)).diff).toEqual({ added: 412, removed: 88 });
    // A turn that changed nothing does not hide what the last one that did changed.
    await event(created.sessionId, "turn.completed", completed(null), at(10));
    expect((await summary(created.projectId)).diff).toEqual({ added: 412, removed: 88 });
  });
});

describe("the card's model", () => {
  it("is the newest turn that ran, never a queued one or an open", async () => {
    const created = await createProjectSession(db, { userId: owner });
    expect((await summary(created.projectId)).model).toBeNull();
    const request = (model: string, minutes: number, extra: object) =>
      db.insert(turnRequests).values({
        id: randomUUID(),
        sessionId: created.sessionId,
        userId: owner,
        message: "Work",
        model,
        createdAt: at(minutes),
        kind: "turn",
        ...extra,
      });
    await request("openai/gpt-5.6-luna", 30, {
      state: "done",
      startedAt: at(30),
      finishedAt: at(29),
    });
    expect((await summary(created.projectId)).model).toBe("openai/gpt-5.6-luna");
    await request("openai/gpt-5.6-terra", 20, {
      kind: "resume",
      message: null,
      state: "done",
      startedAt: at(20),
      finishedAt: at(20),
    });
    await request("openai/gpt-5.6-terra", 10, {});
    expect((await summary(created.projectId)).model).toBe("openai/gpt-5.6-luna");
  });
});

describe("search", () => {
  it("finds the caller's sessions by name or by their own words, and nobody else's", async () => {
    const tag = randomUUID().slice(0, 8);
    const named = await createProjectSession(db, { userId: owner, name: `Invoice ${tag} tool` });
    const said = await createProjectSession(db, { userId: owner, name: "Unrelated" });
    const long = `${"a".repeat(300)} make the ${tag} button blue ${"b".repeat(300)}`;
    await event(said.sessionId, "user.message", { text: long }, at(5));
    const repaired = await createProjectSession(db, { userId: owner, name: "Repaired" });
    await event(
      repaired.sessionId,
      "user.message",
      { text: `fix the ${tag} check`, repair: { requestId: randomUUID(), jobId: randomUUID() } },
      at(4),
    );
    const [stranger] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: "Stranger" })
      .returning();
    if (!stranger) throw new Error("Missing user");
    const theirs = await createProjectSession(db, { userId: stranger.id, name: `Their ${tag}` });
    await event(theirs.sessionId, "user.message", { text: `their ${tag}` }, at(3));

    const { results } = await store.search(owner, tag.toUpperCase());
    expect(results.map((result) => result.projectId)).toEqual([named.projectId, said.projectId]);
    expect(results[0]?.match).toEqual({ in: "name" });
    const match = results[1]?.match;
    if (match?.in !== "message") throw new Error("Expected a message match");
    expect(match.snippet).toContain(`make the ${tag} button`);
    expect(match.snippet.length).toBeLessThanOrEqual(200);
    expect(match).toMatchObject({ cutStart: true, cutEnd: true });
    await db.delete(users).where(eq(users.id, stranger.id));
  });

  it("takes the query's wildcards literally", async () => {
    const tag = randomUUID().slice(0, 8);
    const literal = await createProjectSession(db, { userId: owner, name: `${tag} 50% off` });
    await createProjectSession(db, { userId: owner, name: `${tag} 500 items` });
    await createProjectSession(db, { userId: owner, name: `${tag}x under_score` });
    expect((await store.search(owner, `${tag} 50%`)).results.map((r) => r.projectId)).toEqual([
      literal.projectId,
    ]);
    expect((await store.search(owner, `${tag}_`)).results).toEqual([]);
  });

  it("returns at most a page of sessions", async () => {
    const tag = randomUUID().slice(0, 8);
    for (let index = 0; index < 25; index++)
      await createProjectSession(db, { userId: owner, name: `${tag} ${index}` });
    expect((await store.search(owner, tag)).results).toHaveLength(20);
  });

  it("can answer a message search from the trigram index", async () => {
    // Seq scans off, so a plan that still reads the table means no index could answer it.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(sql`
        explain select 1 from events
        where type in ('user.message', 'steer.received') and (payload->>'text') ilike '%needle%'
      `);
    });
    expect(JSON.stringify(plan)).toContain("events_message_text_trgm");
  });
});

describe("auto-settle settings", () => {
  it("are off until saved, and read back as saved", async () => {
    const [person] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: "Settings" })
      .returning();
    if (!person) throw new Error("Missing user");
    expect(await store.autoSettleSettings(person.id)).toEqual({ afterDays: null, onMerge: false });
    await store.saveAutoSettleSettings(person.id, { afterDays: 7, onMerge: true });
    expect(await store.autoSettleSettings(person.id)).toEqual({ afterDays: 7, onMerge: true });
    await store.saveAutoSettleSettings(person.id, { afterDays: null, onMerge: false });
    expect(await store.autoSettleSettings(person.id)).toEqual({ afterDays: null, onMerge: false });
    await db.delete(users).where(eq(users.id, person.id));
  });
});
