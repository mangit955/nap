/**
 * The two indexes the hot reads stand on, and proof that the stores' own queries can use them.
 *
 * **What is EXPLAINed is the SQL a store really sent**, captured through postgres.js's `debug`
 * hook, not a hand-written copy of it. A copy would go on passing after the store's query had
 * drifted into a shape no index serves, which is the change this file exists to catch.
 *
 * **`enable_seqscan = off`, and why that is the honest setting here.** The container's tables are
 * a few hundred rows, and at that size a sequential scan is the right plan and the planner picks
 * it whether or not an index exists, so a natural plan would say nothing. Turning the scan off
 * does not forbid it: a query no index can serve still gets a `Seq Scan`, just priced high. So the
 * plan names the index exactly when the index can answer the query. Whether the planner then
 * *prefers* it is a question of table size, and at production sizes it does.
 *
 * The container is shared across the `db` project, so the seeds belong to a fresh user and every
 * assertion is about plans, never about counts other files could move.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresCapacityReconciler } from "./postgres-capacity-reconciler.ts";
import { PostgresProjectSandboxStore } from "./postgres-project-sandbox-store.ts";
import { PostgresProjectStore } from "./postgres-project-store.ts";
import { projects, users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";

type Sent = { query: string; parameters: unknown[] };

let client: postgres.Sql;
let db: PostgresJsDatabase;
/** Every statement the client sends, in order; read and cleared by `sentBy`. */
let sent: Sent[] = [];
let userId: string;

beforeAll(async () => {
  client = postgres(inject("postgresUrl"), {
    max: 1,
    debug: (_connection, query, parameters) => sent.push({ query, parameters }),
  });
  db = drizzle(client);

  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning({ id: users.id });
  if (user === undefined) throw new Error("no user");
  userId = user.id;

  // One project serving a sandbox and one that is not, each with a conversation, so every join
  // below has rows on both sides.
  const running = await createProjectSession(db, { userId, name: "running" });
  await createProjectSession(db, { userId, name: "idle" });
  await db
    .update(projects)
    .set({ sandboxId: `sbx-${randomUUID()}` })
    .where(sql`${projects.id} = ${running.projectId}`);
});

afterAll(async () => {
  await client.end();
});

/** The statements `run` sent, and nothing else. */
async function sentBy(run: () => Promise<unknown>): Promise<Sent[]> {
  sent = [];
  await run();
  const mine = sent;
  sent = [];
  return mine;
}

/** The plan of one captured statement, as text, with sequential scans priced out. */
async function planOf({ query, parameters }: Sent): Promise<string> {
  const rows = await client.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    return await tx.unsafe(`explain ${query}`, parameters as postgres.ParameterOrJSON<never>[]);
  });
  return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
}

async function plansOf(run: () => Promise<unknown>): Promise<string> {
  const statements = await sentBy(run);
  expect(statements.length).toBeGreaterThan(0);
  const plans: string[] = [];
  for (const statement of statements) plans.push(await planOf(statement));
  return plans.join("\n---\n");
}

describe("the indexes", () => {
  it("index sessions by project, and projects by the sandbox serving them — partially", async () => {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes
      where indexname in ('sessions_project_id', 'projects_running_sandbox')
      order by indexname
    `);

    expect(rows.map((row) => row.indexname)).toEqual([
      "projects_running_sandbox",
      "sessions_project_id",
    ]);
    // Partial: only a running project has a sandbox id, so the index is the size of the cap on
    // running sandboxes rather than of every project anybody ever made.
    expect(rows[0]?.indexdef).toMatch(/\(sandbox_id\) WHERE \(sandbox_id IS NOT NULL\)$/);
    expect(rows[1]?.indexdef).toMatch(/\(project_id\)$/);
  });
});

describe("sessions_project_id", () => {
  it("serves the project listing's join onto sessions", async () => {
    const plan = await plansOf(() => new PostgresProjectStore(db).list(userId));

    expect(plan).toContain("sessions_project_id");
    expect(plan).not.toContain("Seq Scan on sessions");
  });
});

describe("projects_running_sandbox", () => {
  it("serves the sandbox quota's counts", async () => {
    const store = new PostgresProjectStore(db);
    const plan = await plansOf(async () => {
      await store.countRunningSandboxes(userId);
      await store.countRunningSandboxes();
    });

    expect(plan).toContain("projects_running_sandbox");
    expect(plan).not.toContain("Seq Scan on projects");
  });

  it("serves the idle sweep's filter", async () => {
    const plan = await plansOf(() =>
      new PostgresProjectSandboxStore(db).idleSince(new Date().toISOString()),
    );

    expect(plan).toContain("projects_running_sandbox");
    expect(plan).not.toContain("Seq Scan on projects");
  });

  it("serves the reconciler's lookups by sandbox id", async () => {
    const reconciler = new PostgresCapacityReconciler(db);
    const plan = await plansOf(async () => {
      await reconciler.referencedSandboxIds();
      await reconciler.reclaimStranded();
    });

    expect(plan).toContain("projects_running_sandbox");
    expect(plan).not.toContain("Seq Scan on projects");
  });
});
