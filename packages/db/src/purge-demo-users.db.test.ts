/**
 * The teardown a deployed load run needs (`docs/scaling-design.md` §24 item 6).
 *
 * A ramp to 100 goes through the demo door a hundred times, and each of those identities keeps a
 * project, a session and every event of every turn it ran. Nothing expires them: the reaper puts
 * an idle project's *sandbox* away and deliberately leaves the row. So a weekly run is a
 * permanent, growing population of throwaway accounts in the same table real ones live in.
 *
 * Every assertion here is about something the sweep must *not* take with it.
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { purgeDemoUsers } from "./purge-demo-users.ts";
import { projects, sessions, turnRequests, users } from "./schema.ts";

let client: postgres.Sql;
let database: PostgresJsDatabase;

beforeAll(() => {
  client = postgres(inject("postgresUrl"), { max: 4 });
  database = drizzle(client);
});

afterAll(async () => {
  await client.end();
});

/** Everything this file makes is tagged, so a shared container's other rows are never counted. */
const TAG = `purge-${crypto.randomUUID().slice(0, 8)}`;

async function makeUser(
  database: PostgresJsDatabase,
  options: { anonymous: boolean; ageMinutes: number },
): Promise<string> {
  const [row] = await database
    .insert(users)
    .values({
      email: `${TAG}-${crypto.randomUUID()}@example.test`,
      name: TAG,
      isAnonymous: options.anonymous,
      createdAt: sql`now() - ${`${options.ageMinutes} minutes`}::interval`,
    })
    .returning({ id: users.id });
  if (row === undefined) throw new Error("the fixture user was not inserted");
  return row.id;
}

async function makeProject(
  database: PostgresJsDatabase,
  userId: string,
  sandboxId?: string,
): Promise<{ projectId: string; sessionId: string }> {
  const [project] = await database
    .insert(projects)
    .values({
      userId,
      name: TAG,
      slug: crypto.randomUUID(),
      ...(sandboxId === undefined ? {} : { sandboxId }),
    })
    .returning({ id: projects.id });
  if (project === undefined) throw new Error("the fixture project was not inserted");

  const [session] = await database
    .insert(sessions)
    .values({ projectId: project.id, title: TAG })
    .returning({ id: sessions.id });
  if (session === undefined) throw new Error("the fixture session was not inserted");

  return { projectId: project.id, sessionId: session.id };
}

describe("purgeDemoUsers", () => {
  it("removes an old anonymous identity and everything hanging off it", async () => {
    const userId = await makeUser(database, { anonymous: true, ageMinutes: 120 });
    const { projectId } = await makeProject(database, userId);

    const purged = await purgeDemoUsers(database, { olderThanMinutes: 60 });

    expect(purged.userIds).toContain(userId);
    // The cascade is the schema's, not this function's — asserted because a future migration
    // that dropped it would leave orphaned projects nothing ever collects.
    expect(await database.select().from(projects).where(eq(projects.id, projectId))).toEqual([]);
  });

  it("leaves a registered account alone, however old", async () => {
    // The one mistake here that cannot be undone. Age is the only other predicate, so an
    // `is_anonymous` clause dropped from the query deletes the people who signed up.
    const userId = await makeUser(database, { anonymous: false, ageMinutes: 10_000 });

    const purged = await purgeDemoUsers(database, { olderThanMinutes: 60 });

    expect(purged.userIds).not.toContain(userId);
    expect(await database.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it("leaves a demo visitor who is still here", async () => {
    // A run's users are minutes old at the point somebody tears down, and so is whoever is
    // trying the product right now. The window is what tells them apart.
    const userId = await makeUser(database, { anonymous: true, ageMinutes: 5 });

    const purged = await purgeDemoUsers(database, { olderThanMinutes: 60 });

    expect(purged.userIds).not.toContain(userId);
  });

  it.each(["queued", "leased"] as const)(
    "leaves an identity whose turn is %s, and takes it on the next sweep",
    async (state) => {
      // Deleting a session out from under an executing turn is a worker writing events for a
      // row that no longer exists — a foreign-key failure mid-turn, which is a stuck request
      // rather than a tidy one. A queued one is the same turn a moment earlier. The sweep is
      // scheduled and repeats, so waiting costs nothing.
      const userId = await makeUser(database, { anonymous: true, ageMinutes: 120 });
      const { sessionId } = await makeProject(database, userId);
      const requestId = crypto.randomUUID();
      await database.insert(turnRequests).values({
        id: requestId,
        sessionId,
        userId,
        kind: "turn",
        state,
        model: "purge/fake",
        message: TAG,
      });

      expect((await purgeDemoUsers(database, { olderThanMinutes: 60 })).userIds).not.toContain(
        userId,
      );

      await database
        .update(turnRequests)
        .set({ state: "done" })
        .where(eq(turnRequests.id, requestId));

      expect((await purgeDemoUsers(database, { olderThanMinutes: 60 })).userIds).toContain(userId);
    },
  );

  it("names the sandboxes it is about to orphan", async () => {
    // Nothing in Postgres destroys an E2B sandbox, and once the project row is gone the
    // reaper will not either — a sandbox whose project this database does not know is left
    // alone on purpose, so that a benchmark run is not killed by somebody else's tidy-up. So
    // the caller is told, and `loadgen-teardown.ts` is what acts on it.
    const userId = await makeUser(database, { anonymous: true, ageMinutes: 120 });
    await makeProject(database, userId, "sbx-orphan-1");

    const purged = await purgeDemoUsers(database, { olderThanMinutes: 60 });

    expect(purged.orphanedSandboxIds).toContain("sbx-orphan-1");
  });

  it("deletes nothing when asked to look only", async () => {
    const userId = await makeUser(database, { anonymous: true, ageMinutes: 120 });

    const purged = await purgeDemoUsers(database, { olderThanMinutes: 60, dryRun: true });

    expect(purged.userIds).toContain(userId);
    expect(await database.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it("takes no more than it was asked for in one pass", async () => {
    await makeUser(database, { anonymous: true, ageMinutes: 120 });
    await makeUser(database, { anonymous: true, ageMinutes: 120 });

    const purged = await purgeDemoUsers(database, { olderThanMinutes: 60, limit: 1 });

    expect(purged.userIds).toHaveLength(1);
    // And the rest are still there to be taken by the next pass.
    const left = await database
      .select()
      .from(users)
      .where(and(eq(users.name, TAG), eq(users.isAnonymous, true)));
    expect(left.length).toBeGreaterThan(0);
  });
});
