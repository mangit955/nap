import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresProjectStore } from "./postgres-project-store.ts";
import { PostgresProjectTitleStore } from "./postgres-project-title-store.ts";
import { projects, users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";
import { PostgresSessionNavigationStore } from "./session-navigation-store.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let titles: PostgresProjectTitleStore;
let store: PostgresProjectStore;
let owner: string;

beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 3 });
  db = drizzle(connection);
  titles = new PostgresProjectTitleStore(db);
  store = new PostgresProjectStore(db);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Titles" })
    .returning();
  owner = user?.id ?? "";
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await connection.end();
});

async function row(projectId: string) {
  const [found] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!found) throw new Error("Missing project");
  return found;
}

/** A project named the way a first prompt names one: a seed, which a model title may replace. */
async function seeded(name: string) {
  const created = await createProjectSession(db, { userId: owner });
  await db
    .update(projects)
    .set({ name, nameSource: "seed" })
    .where(eq(projects.id, created.projectId));
  return created;
}

let seq = 1;
async function said(sessionId: string, text: string, extra: object = {}) {
  await db.execute(sql`
    insert into events (session_id, turn_id, seq, type, payload)
    values (${sessionId}, ${randomUUID()}, ${seq++}, 'user.message',
      ${JSON.stringify({ text, ...extra })}::jsonb)
  `);
}

describe("name source", () => {
  it("is the person's when they typed it creating the project, and a seed otherwise", async () => {
    const typed = await createProjectSession(db, { userId: owner, name: "My tracker" });
    expect((await row(typed.projectId)).nameSource).toBe("user");
    const untitled = await createProjectSession(db, { userId: owner });
    expect((await row(untitled.projectId)).nameSource).toBe("seed");
  });

  it("starts as a seed, a seed rename keeps it, and a user rename makes it the person's", async () => {
    const created = await seeded("Habit Tracker");
    expect((await row(created.projectId)).nameSource).toBe("seed");
    expect(await store.rename(created.projectId, owner, "Habit Tracker App", "seed")).toBe(true);
    expect((await row(created.projectId)).nameSource).toBe("seed");
    expect(await store.rename(created.projectId, owner, "My tracker")).toBe(true);
    expect((await row(created.projectId)).nameSource).toBe("user");
    // A seed never lands on a name somebody chose.
    expect(await store.rename(created.projectId, owner, "Habit Tracker", "seed")).toBe(false);
    expect((await row(created.projectId)).name).toBe("My tracker");
  });
});

describe("claim", () => {
  it("is automatic once per project, only over a seed, and never twice at once", async () => {
    const created = await seeded("Habit Tracker");
    const first = await titles.claim(created.projectId, owner, "automatic");
    expect(first).toMatchObject({ currentName: "Habit Tracker", sessionId: created.sessionId });
    expect(await titles.claim(created.projectId, owner, "automatic")).toBe("in_flight");
    expect(await titles.claim(created.projectId, owner, "manual")).toBe("in_flight");
    if (typeof first === "string") throw new Error("Missing claim");
    await titles.release(created.projectId, first.generation);
    // Released, but the automatic title was attempted; only a person may ask again.
    await db
      .update(projects)
      .set({ titleRequestedAt: new Date(Date.now() - 60_000) })
      .where(eq(projects.id, created.projectId));
    expect(await titles.claim(created.projectId, owner, "automatic")).toBe("refused");
    expect(await titles.claim(created.projectId, owner, "manual")).toMatchObject({
      generation: expect.any(String),
    });
  });

  it("refuses an automatic title over the person's own name, and anybody else's project", async () => {
    const named = await seeded("Seed");
    await store.rename(named.projectId, owner, "Mine");
    expect(await titles.claim(named.projectId, owner, "automatic")).toBe("refused");
    expect(await titles.claim(named.projectId, randomUUID(), "manual")).toBe("refused");
  });

  it("refuses a second title while one is still being written, after the cooldown has passed", async () => {
    const created = await seeded("Seed");
    expect(await titles.claim(created.projectId, owner, "manual")).toMatchObject({
      sessionId: created.sessionId,
    });
    // Past the cooldown, inside the expiry, with the first claim still standing: a slow model
    // call is in flight, and a second one would be paid for and then thrown away.
    await db
      .update(projects)
      .set({ titleRequestedAt: new Date(Date.now() - 30_000) })
      .where(eq(projects.id, created.projectId));
    expect(await titles.claim(created.projectId, owner, "manual")).toBe("in_flight");
  });

  it("says a title was asked for moments ago, apart from one being written now", async () => {
    const created = await seeded("Seed");
    const first = await titles.claim(created.projectId, owner, "manual");
    if (typeof first === "string") throw new Error("Missing claim");
    expect(await titles.claim(created.projectId, owner, "manual")).toBe("in_flight");
    await titles.apply(created.projectId, first.generation, "Standup streak tracker", "manual");
    expect(await titles.claim(created.projectId, owner, "manual")).toBe("cooldown");
  });

  it("takes over a claim abandoned for longer than its expiry", async () => {
    const created = await seeded("Seed");
    expect(await titles.claim(created.projectId, owner, "manual")).toMatchObject({
      generation: expect.any(String),
    });
    await db
      .update(projects)
      .set({ titleRequestedAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(projects.id, created.projectId));
    expect(await titles.claim(created.projectId, owner, "manual")).toMatchObject({
      generation: expect.any(String),
    });
  });

  it("carries the person's first and latest messages, not the verifier's, and the source", async () => {
    const created = await seeded("Seed");
    for (const text of ["first", "second", "third", "fourth", "fifth"])
      await said(created.sessionId, text);
    await said(created.sessionId, "fix the failing check", {
      repair: { requestId: randomUUID(), jobId: randomUUID() },
    });
    const claim = await titles.claim(created.projectId, owner, "manual");
    expect(claim).toMatchObject({
      messages: ["first", "third", "fourth", "fifth"],
      sourceName: null,
    });
  });
});

describe("the sidebar's view of it", () => {
  it("says a title is being written from the claim until it lands", async () => {
    const navigation = new PostgresSessionNavigationStore(db);
    const titling = async (projectId: string) =>
      (await navigation.list(owner)).sessions.find((s) => s.projectId === projectId)?.titling;
    const created = await seeded("Seed");
    expect(await titling(created.projectId)).toBe(false);
    const claim = await titles.claim(created.projectId, owner, "manual");
    if (typeof claim === "string") throw new Error("Missing claim");
    expect(await titling(created.projectId)).toBe(true);
    await titles.apply(created.projectId, claim.generation, "Standup streak tracker", "manual");
    expect(await titling(created.projectId)).toBe(false);
  });
});

describe("apply", () => {
  it("writes the model's name while the claim stands, and only once", async () => {
    const created = await seeded("Habit Tracker");
    const claim = await titles.claim(created.projectId, owner, "automatic");
    if (typeof claim === "string") throw new Error("Missing claim");
    expect(
      await titles.apply(created.projectId, claim.generation, "Team Standup Streaks", "automatic"),
    ).toBe(true);
    const after = await row(created.projectId);
    expect(after).toMatchObject({
      name: "Team Standup Streaks",
      nameSource: "model",
      titleGeneration: null,
    });
    expect(await titles.apply(created.projectId, claim.generation, "Again", "automatic")).toBe(
      false,
    );
  });

  it("loses to a rename that lands while the title is being written", async () => {
    // Both modes: a regenerate has no `name_source` guard, so only the cleared claim stops it.
    for (const mode of ["automatic", "manual"] as const) {
      const created = await seeded("Habit Tracker");
      const claim = await titles.claim(created.projectId, owner, mode);
      if (typeof claim === "string") throw new Error("Missing claim");
      await store.rename(created.projectId, owner, "What I typed");
      expect(
        await titles.apply(created.projectId, claim.generation, "Model title here", mode),
      ).toBe(false);
      expect(await row(created.projectId)).toMatchObject({
        name: "What I typed",
        nameSource: "user",
      });
    }
  });

  it("loses to a rename racing it, whichever statement reaches the row first", async () => {
    for (let round = 0; round < 10; round++) {
      const created = await seeded("Seed");
      const claim = await titles.claim(created.projectId, owner, "manual");
      if (typeof claim === "string") throw new Error("Missing claim");
      const [applied] = await Promise.all([
        titles.apply(created.projectId, claim.generation, "Model title here", "manual"),
        store.rename(created.projectId, owner, "What I typed"),
      ]);
      const after = await row(created.projectId);
      // Either the rename came second and overwrote the title, or it came first and the title
      // found its claim gone. The person's name is what is left, every time.
      expect(after).toMatchObject({ name: "What I typed", nameSource: "user" });
      expect(typeof applied).toBe("boolean");
    }
  });

  it("does nothing after a release", async () => {
    const created = await seeded("Seed");
    const claim = await titles.claim(created.projectId, owner, "manual");
    if (typeof claim === "string") throw new Error("Missing claim");
    await titles.release(created.projectId, claim.generation);
    expect(
      await titles.apply(created.projectId, claim.generation, "Late answer here", "manual"),
    ).toBe(false);
    expect((await row(created.projectId)).name).toBe("Seed");
  });
});
