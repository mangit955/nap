import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  githubInstallations,
  projectRepositories,
  projects,
  repositoryJobs,
  turnRequests,
  users,
} from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";
import { PostgresSessionNavigationStore } from "./session-navigation-store.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresSessionNavigationStore;
const people: string[] = [];

beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 3 });
  db = drizzle(connection);
  store = new PostgresSessionNavigationStore(db);
});
afterAll(async () => {
  if (people.length) await db.delete(users).where(inArray(users.id, people));
  await connection.end();
});

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Somebody with these rules, or with none saved at all — which is both rules off. */
async function person(rules?: { afterDays: number | null; onMerge: boolean }): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Auto-settle" })
    .returning();
  if (!row) throw new Error("Missing user");
  people.push(row.id);
  if (rules) await store.saveAutoSettleSettings(row.id, rules);
  return row.id;
}

/** A session whose last request finished `quietDays` ago. */
async function quietSession(userId: string, quietDays: number) {
  const created = await createProjectSession(db, { userId });
  const then = daysAgo(quietDays);
  await db.update(projects).set({ createdAt: then }).where(eq(projects.id, created.projectId));
  await db.insert(turnRequests).values({
    id: randomUUID(),
    sessionId: created.sessionId,
    userId,
    kind: "turn",
    message: "Work",
    model: "free",
    state: "done",
    createdAt: then,
    startedAt: then,
    finishedAt: then,
  });
  return created;
}

async function navigation(projectId: string) {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!row) throw new Error("Missing project");
  return { ...row.navigation, revision: row.navigationRevision };
}

/** Settles everything due and answers whether this project was among it. */
async function settles(projectId: string): Promise<boolean> {
  return (await store.autoSettle(10_000)).includes(projectId);
}

describe("auto-settle after days without activity", () => {
  it("settles a quiet session once, as a manual settle would, and is idempotent", async () => {
    const owner = await person({ afterDays: 7, onMerge: false });
    const quiet = await quietSession(owner, 8);
    const recent = await quietSession(owner, 3);

    expect(await settles(quiet.projectId)).toBe(true);
    const settled = await navigation(quiet.projectId);
    expect(settled.doneAt).not.toBeNull();
    expect(settled.snoozedUntil).toBeNull();
    expect(settled.revision).toBe(1);
    // The stamp parses where every other navigation stamp does.
    expect(new Date(settled.doneAt ?? "").toISOString()).toBe(settled.doneAt);
    const list = await store.list(owner);
    expect(list.sessions.find((row) => row.projectId === quiet.projectId)).toBeDefined();

    expect(await settles(quiet.projectId)).toBe(false);
    expect((await navigation(quiet.projectId)).revision).toBe(1);
    expect(await settles(recent.projectId)).toBe(false);
  });

  it("is off for somebody who never turned it on", async () => {
    const owner = await person();
    const quiet = await quietSession(owner, 400);
    expect(await settles(quiet.projectId)).toBe(false);
    const off = await person({ afterDays: null, onMerge: false });
    expect(await settles((await quietSession(off, 400)).projectId)).toBe(false);
  });

  it("never settles a pinned session", async () => {
    const owner = await person({ afterDays: 1, onMerge: true });
    const quiet = await quietSession(owner, 30);
    await store.change(owner, quiet.projectId, {
      revision: 0,
      change: { kind: "pin", pinned: true },
    });
    expect(await settles(quiet.projectId)).toBe(false);
  });

  it("never settles a busy session, queued or running", async () => {
    const owner = await person({ afterDays: 1, onMerge: false });
    for (const state of ["queued", "leased"] as const) {
      const quiet = await quietSession(owner, 30);
      // Admitted long ago and still in flight: busy is the row's state, not how recent it is.
      await db.insert(turnRequests).values({
        id: randomUUID(),
        sessionId: quiet.sessionId,
        userId: owner,
        kind: "turn",
        message: "Still going",
        model: "free",
        state,
        createdAt: daysAgo(10),
        ...(state === "leased"
          ? { startedAt: daysAgo(10), leaseOwner: "worker", leaseExpiresAt: new Date() }
          : {}),
      });
      expect(await settles(quiet.projectId)).toBe(false);
    }
  });

  it("leaves a snoozed or archived session alone", async () => {
    const owner = await person({ afterDays: 1, onMerge: false });
    const snoozed = await quietSession(owner, 30);
    await store.change(owner, snoozed.projectId, {
      revision: 0,
      change: { kind: "snooze", until: new Date(Date.now() + 86_400_000).toISOString() },
    });
    const archived = await quietSession(owner, 30);
    await store.change(owner, archived.projectId, {
      revision: 0,
      change: { kind: "archive", value: true },
    });
    const settled = await store.autoSettle(10_000);
    expect(settled).not.toContain(snoozed.projectId);
    expect(settled).not.toContain(archived.projectId);
  });

  it("does not settle again what its owner un-settled, until something new happens", async () => {
    const owner = await person({ afterDays: 7, onMerge: false });
    const quiet = await quietSession(owner, 30);
    expect(await settles(quiet.projectId)).toBe(true);
    const unsettled = await store.change(owner, quiet.projectId, {
      revision: 1,
      change: { kind: "done", value: false },
    });
    expect(unsettled.kind).toBe("saved");
    expect(await settles(quiet.projectId)).toBe(false);
    expect((await navigation(quiet.projectId)).doneAt).toBeNull();

    // New work, then quiet again for longer than the rule: that is a new reason to settle.
    await db.insert(turnRequests).values({
      id: randomUUID(),
      sessionId: quiet.sessionId,
      userId: owner,
      kind: "turn",
      message: "One more thing",
      model: "free",
      state: "done",
      createdAt: new Date(Date.now() + 1000),
      finishedAt: new Date(Date.now() + 1000),
    });
    expect(await settles(quiet.projectId)).toBe(false);
    await db
      .update(projects)
      .set({ autoSettleFloor: daysAgo(20) })
      .where(eq(projects.id, quiet.projectId));
    await db
      .update(turnRequests)
      .set({ createdAt: daysAgo(10), finishedAt: daysAgo(10) })
      .where(eq(turnRequests.message, "One more thing"));
    expect(await settles(quiet.projectId)).toBe(true);
  });

  it("does not settle a session its owner un-settled by hand without the rule ever firing", async () => {
    const owner = await person({ afterDays: 7, onMerge: false });
    const quiet = await quietSession(owner, 30);
    await store.change(owner, quiet.projectId, {
      revision: 0,
      change: { kind: "done", value: true },
    });
    await store.change(owner, quiet.projectId, {
      revision: 1,
      change: { kind: "done", value: false },
    });
    expect(await settles(quiet.projectId)).toBe(false);
  });

  it("settles no more than it is asked to in one tick", async () => {
    const owner = await person({ afterDays: 1, onMerge: false });
    for (let index = 0; index < 3; index++) await quietSession(owner, 30);
    expect(await store.autoSettle(2)).toHaveLength(2);
  });
});

describe("auto-settle when the pull request merges", () => {
  async function imported(userId: string, state: "open" | "merged", recordedDaysAgo: number) {
    const created = await quietSession(userId, 5);
    const installationId = 7_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
    await db.insert(githubInstallations).values({
      installationId,
      userId,
      githubUserId: installationId,
      githubLogin: "owner",
      accountLogin: "repo-owner",
      accountType: "Organization",
      status: "active",
    });
    await db.insert(projectRepositories).values({
      projectId: created.projectId,
      sessionId: created.sessionId,
      installationId,
      repository: { fullName: "repo-owner/app" },
      baseBranch: "main",
      environment: {},
      autoPublish: true,
    });
    const jobId = randomUUID();
    await db.insert(repositoryJobs).values({
      jobId,
      projectId: created.projectId,
      sessionId: created.sessionId,
      baseBranch: "main",
      headBranch: "nap/change",
      baseSha: "a".repeat(40),
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.com/repo-owner/app/pull/7",
      pullRequestState: state,
      publishState: "published",
      checkState: "passed",
      reviewState: "unknown",
      updatedAt: daysAgo(recordedDaysAgo),
    });
    return { ...created, jobId };
  }

  it("settles a session whose pull request merged after its last turn", async () => {
    const owner = await person({ afterDays: null, onMerge: true });
    const open = await imported(owner, "open", 1);
    const merged = await imported(owner, "merged", 1);
    const settled = await store.autoSettle(10_000);
    expect(settled).toContain(merged.projectId);
    expect(settled).not.toContain(open.projectId);
    expect(await settles(merged.projectId)).toBe(false);
  });

  it("does not settle work that came after the merge, or without the rule", async () => {
    const owner = await person({ afterDays: null, onMerge: true });
    // Recorded merged six days ago; the session's last turn finished five days ago.
    const stale = await imported(owner, "merged", 6);
    expect(await settles(stale.projectId)).toBe(false);
    const off = await person({ afterDays: 30, onMerge: false });
    expect(await settles((await imported(off, "merged", 1)).projectId)).toBe(false);
  });

  it("needs the integration's record, and settles nothing without one", async () => {
    const owner = await person({ afterDays: null, onMerge: true });
    expect(await settles((await quietSession(owner, 30)).projectId)).toBe(false);
  });
});
