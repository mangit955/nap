import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresProjectSandboxStore } from "./postgres-project-sandbox-store.ts";
import { events, projects, sessions, users } from "./schema.ts";

/**
 * Against a real Postgres, because what is being tested is a query rather than a class: which
 * projects count as idle is decided by a join and an aggregate over the event log, and a fake
 * that reimplemented that would agree with itself forever.
 *
 * The container is shared across the `db` project, so nothing here may assume an empty table —
 * every assertion is scoped to the ids it seeded.
 */

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000);
const MINUTE_AGO = new Date(Date.now() - 60 * 1000);
/** Anything whose newest activity is older than this is idle. */
const CUTOFF = new Date(Date.now() - 10 * 60 * 1000).toISOString();

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresProjectSandboxStore;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  store = new PostgresProjectSandboxStore(db);
});

afterAll(async () => {
  await sql.end();
});

type SeedOptions = {
  sandboxId?: string | null;
  /** When the project row itself was last touched — the floor for activity. */
  updatedAt?: Date;
};

async function seedProject(options: SeedOptions = {}): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({
      userId: user?.id ?? "",
      name: "Todo app",
      slug: `todo-${randomUUID()}`,
      sandboxId: options.sandboxId === undefined ? `sb-${randomUUID()}` : options.sandboxId,
      updatedAt: options.updatedAt ?? HOUR_AGO,
    })
    .returning();
  return project?.id ?? "";
}

async function seedSession(projectId: string): Promise<string> {
  const [session] = await db
    .insert(sessions)
    .values({ projectId, title: "First session" })
    .returning();
  return session?.id ?? "";
}

async function seedEvent(sessionId: string, at: Date): Promise<void> {
  await db.insert(events).values({
    sessionId,
    turnId: randomUUID(),
    seq: Math.floor(Math.random() * 1_000_000),
    type: "user.message",
    payload: { text: "carry on" },
    createdAt: at,
  });
}

async function idleIds(): Promise<string[]> {
  const idle = await store.idleSince(CUTOFF);
  return idle.map((project) => project.projectId);
}

describe("idleSince", () => {
  it("offers a project whose newest event is older than the cutoff", async () => {
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);
    await seedEvent(sessionId, HOUR_AGO);

    const idle = await store.idleSince(CUTOFF);

    expect(idle).toContainEqual({
      projectId,
      sandboxId: expect.stringMatching(/^sb-/),
      sessionIds: [sessionId],
      lastActiveAt: HOUR_AGO.toISOString(),
    });
  });

  it("withholds a project with a recent event, however old its other events are", async () => {
    // Activity resets the timer. Taking the oldest event, or the project row's own timestamp,
    // would reap a workspace somebody is using.
    const projectId = await seedProject();
    const sessionId = await seedSession(projectId);
    await seedEvent(sessionId, HOUR_AGO);
    await seedEvent(sessionId, MINUTE_AGO);

    await expect(idleIds()).resolves.not.toContain(projectId);
  });

  it("counts activity in any of the project's sessions", async () => {
    // A sandbox belongs to the project, so a second conversation about it is activity on it.
    const projectId = await seedProject();
    const quiet = await seedSession(projectId);
    const busy = await seedSession(projectId);
    await seedEvent(quiet, HOUR_AGO);
    await seedEvent(busy, MINUTE_AGO);

    await expect(idleIds()).resolves.not.toContain(projectId);
  });

  it("never offers a project with no sandbox", async () => {
    const projectId = await seedProject({ sandboxId: null });
    await seedEvent(await seedSession(projectId), HOUR_AGO);

    await expect(idleIds()).resolves.not.toContain(projectId);
  });

  it("uses the project's own timestamp when it has no events yet", async () => {
    // A sandbox created for a turn that then failed leaves a project with a sandbox and an
    // empty log. Without a floor it would look infinitely idle to some queries and never
    // idle to others; here it is simply as old as the project row says.
    const fresh = await seedProject({ updatedAt: MINUTE_AGO });
    const stale = await seedProject({ updatedAt: HOUR_AGO });

    const ids = await idleIds();

    expect(ids).toContain(stale);
    expect(ids).not.toContain(fresh);
  });

  it("lists every session of an idle project, so a caller can check for a running turn", async () => {
    const projectId = await seedProject();
    const first = await seedSession(projectId);
    const second = await seedSession(projectId);
    await seedEvent(first, HOUR_AGO);

    const found = (await store.idleSince(CUTOFF)).find((p) => p.projectId === projectId);

    expect(found?.sessionIds.sort()).toEqual([first, second].sort());
  });
});

describe("releaseSandbox", () => {
  it("clears the sandbox and records the snapshot", async () => {
    const projectId = await seedProject();
    const key = `projects/${projectId}/1-abc.bundle`;

    await store.releaseSandbox(projectId, key);

    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(row?.sandboxId).toBeNull();
    expect(row?.snapshotKey).toBe(key);
    // The vocabulary the schema already has for "put away, restorable".
    expect(row?.status).toBe("idle");
  });

  it("takes the project out of the candidate list", async () => {
    // Otherwise the next sweep tries to tear down a sandbox that is already gone, every
    // minute, forever.
    const projectId = await seedProject();
    await seedEvent(await seedSession(projectId), HOUR_AGO);

    await store.releaseSandbox(projectId, "k");

    await expect(idleIds()).resolves.not.toContain(projectId);
  });

  it("throws for a project that does not exist", async () => {
    await expect(store.releaseSandbox(randomUUID(), "k")).rejects.toThrow(/unknown project/);
  });
});
