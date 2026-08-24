import { randomUUID } from "node:crypto";
import { eq, sql as sqlOf } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { PostgresCapacityReconciler } from "./postgres-capacity-reconciler.ts";
import { projects, sandboxReservations, users } from "./schema.ts";

/**
 * Reclamation against a real Postgres, because every rule here is a `where` clause.
 *
 * A fake would have to reimplement "past its expiry" and "no project names this sandbox" in
 * JavaScript and would then agree with itself; what is actually being asserted is that the two
 * statements select the rows they are meant to and — much more importantly — leave alone the ones
 * they are not. A reclamation that took one row too many hands a live project's slot to somebody
 * else and, through the sweep above it, destroys a sandbox somebody is looking at.
 *
 * **This file owns the whole reservations table**, as `postgres-sandbox-capacity.db.test.ts` does
 * and for the same reason: the queries are unscoped, so the assertions have to be.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let reconciler: PostgresCapacityReconciler;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
  reconciler = new PostgresCapacityReconciler(db);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await db.delete(sandboxReservations);
});

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  return user?.id ?? "";
}

async function seedProject(options: { sandboxId?: string } = {}): Promise<{
  projectId: string;
  userId: string;
}> {
  const userId = await seedUser();
  const [project] = await db
    .insert(projects)
    .values({
      userId,
      name: "Todo app",
      slug: `todo-${randomUUID()}`,
      ...(options.sandboxId === undefined ? {} : { sandboxId: options.sandboxId }),
    })
    .returning();
  return { projectId: project?.id ?? "", userId };
}

/**
 * A reservation placed directly, so a test can put its expiry in the past.
 *
 * `age` moves `created_at` back, which is how the activation grace is driven: an `active` row is
 * only believed to be stranded once it is too old to be an acquire still in flight. Every test
 * about an orphan therefore has to age its row, and one that forgot would assert the grace away.
 */
async function seedReservation(row: {
  projectId: string;
  userId: string;
  state: "reserved" | "active";
  sandboxId?: string;
  expiresIn: string;
  age?: string;
}): Promise<string> {
  const [inserted] = await db
    .insert(sandboxReservations)
    .values({
      projectId: row.projectId,
      userId: row.userId,
      state: row.state,
      sandboxId: row.sandboxId ?? null,
      expiresAt: sqlOf`now() + ${row.expiresIn}::interval`,
      ...(row.age === undefined ? {} : { createdAt: sqlOf`now() - ${row.age}::interval` }),
    })
    .returning({ id: sandboxReservations.id });
  return inserted?.id ?? "";
}

describe("a process that died after reserving", () => {
  it("has its slot reclaimed once the reservation has expired", async () => {
    // The failure this exists for: capacity was consumed, the provider was never called, and
    // nothing will ever release the row, so the ceiling is permanently one smaller.
    const { projectId, userId } = await seedProject();
    const id = await seedReservation({
      projectId,
      userId,
      state: "reserved",
      expiresIn: "-1 minute",
    });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.expired).toEqual([id]);
    expect(await db.select().from(sandboxReservations)).toEqual([]);
  });

  it("keeps a reservation whose creation is still in flight", async () => {
    // Seconds old and about to be used. Reclaiming it hands the slot to somebody else while a
    // sandbox is being made against it, which is how the ceiling gets exceeded by the thing
    // meant to enforce it.
    const { projectId, userId } = await seedProject();
    await seedReservation({ projectId, userId, state: "reserved", expiresIn: "2 minutes" });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.expired).toEqual([]);
    expect(await db.select().from(sandboxReservations)).toHaveLength(1);
  });
});

describe("a sandbox destroyed out of band", () => {
  it("has its active row reclaimed once no project names it", async () => {
    // Providers reclaim sandboxes on their own timers. The row outlives the thing it names,
    // and nothing else is ever going to come past and release it.
    const { projectId, userId } = await seedProject();
    const id = await seedReservation({
      projectId,
      userId,
      state: "active",
      sandboxId: "sbx-gone",
      expiresIn: "infinity",
      age: "1 hour",
    });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.orphaned).toEqual([id]);
    expect(await db.select().from(sandboxReservations)).toEqual([]);
  });

  it("leaves an unreferenced active row that was only just activated", async () => {
    // An acquire activates its reservation a moment before it writes the sandbox id onto the
    // project, so for that moment a perfectly healthy row looks exactly like a leak. Reclaiming
    // it would leave a live sandbox counted by nothing, which raises the ceiling rather than
    // holding it — the one direction a limit that caps a bill must never fail in.
    const { projectId, userId } = await seedProject();
    await seedReservation({
      projectId,
      userId,
      state: "active",
      sandboxId: "sbx-just-made",
      expiresIn: "infinity",
    });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.orphaned).toEqual([]);
    expect(await db.select().from(sandboxReservations)).toHaveLength(1);
  });

  it("leaves an active row whose sandbox the project is still holding", async () => {
    // The ordinary case, and by far the most common row in the table: reclaiming it would
    // release the capacity of a sandbox that is running right now.
    const { projectId, userId } = await seedProject({ sandboxId: "sbx-live" });
    await seedReservation({
      projectId,
      userId,
      state: "active",
      sandboxId: "sbx-live",
      expiresIn: "infinity",
      age: "1 hour",
    });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.orphaned).toEqual([]);
    expect(await db.select().from(sandboxReservations)).toHaveLength(1);
  });

  it("leaves an active row naming a sandbox some other project holds", async () => {
    // The row is matched against the whole column rather than against its own project, because
    // the id is what identifies the sandbox and a project row can be updated underneath it.
    const holder = await seedProject({ sandboxId: "sbx-shared" });
    const other = await seedProject();
    await seedReservation({
      projectId: other.projectId,
      userId: other.userId,
      state: "active",
      sandboxId: "sbx-shared",
      expiresIn: "infinity",
      age: "1 hour",
    });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.orphaned).toEqual([]);
    expect(holder.projectId).not.toBe(other.projectId);
  });
});

describe("what the two passes leave behind", () => {
  it("reclaims both kinds in one call and reports them apart", async () => {
    const dead = await seedProject();
    const expiredId = await seedReservation({
      ...dead,
      state: "reserved",
      expiresIn: "-1 minute",
    });
    const reclaimedSandbox = await seedProject();
    const orphanedId = await seedReservation({
      ...reclaimedSandbox,
      state: "active",
      sandboxId: "sbx-vanished",
      expiresIn: "infinity",
      age: "1 hour",
    });

    const reclaimed = await reconciler.reclaimStranded();

    expect(reclaimed.expired).toEqual([expiredId]);
    expect(reclaimed.orphaned).toEqual([orphanedId]);
  });

  it("reports nothing and changes nothing when every row is healthy", async () => {
    const { projectId, userId } = await seedProject({ sandboxId: "sbx-live" });
    await seedReservation({
      projectId,
      userId,
      state: "active",
      sandboxId: "sbx-live",
      expiresIn: "infinity",
      age: "1 hour",
    });

    expect(await reconciler.reclaimStranded()).toEqual({ expired: [], orphaned: [] });
    expect(await db.select().from(sandboxReservations)).toHaveLength(1);
  });
});

describe("which sandboxes anything still points at", () => {
  it("reports the ones projects name, and nothing else", async () => {
    await seedProject({ sandboxId: "sbx-project" });

    const referenced = await reconciler.referencedSandboxIds();

    expect(referenced).toContain("sbx-project");
    expect(referenced).not.toContain("sbx-nobody");
  });

  it("reports one an active reservation names before the project does", async () => {
    // The window this exists for is a couple of statements wide: a sandbox is activated, and
    // the project row is updated to name it immediately afterwards. Whoever reads this destroys
    // what is missing from it, so a set narrower than the truth destroys a live sandbox.
    const { projectId, userId } = await seedProject();
    await seedReservation({
      projectId,
      userId,
      state: "active",
      sandboxId: "sbx-just-made",
      expiresIn: "infinity",
    });

    expect(await reconciler.referencedSandboxIds()).toContain("sbx-just-made");
  });

  it("reports an id named twice only once", async () => {
    // Callers use it as a set. A duplicate is harmless there, but a caller that ever counted
    // this would be counting rows rather than sandboxes.
    const { projectId, userId } = await seedProject({ sandboxId: "sbx-both" });
    await seedReservation({
      projectId,
      userId,
      state: "active",
      sandboxId: "sbx-both",
      expiresIn: "infinity",
    });

    const referenced = await reconciler.referencedSandboxIds();

    expect(referenced.filter((id) => id === "sbx-both")).toHaveLength(1);
  });

  it("leaves out a project whose sandbox has been released", async () => {
    // A put-away project names nothing, which is precisely what makes its old sandbox — if the
    // provider somehow still has it — something to destroy.
    const { projectId } = await seedProject({ sandboxId: "sbx-put-away" });
    await db.update(projects).set({ sandboxId: null }).where(eq(projects.id, projectId));

    expect(await reconciler.referencedSandboxIds()).not.toContain("sbx-put-away");
  });
});

describe("which projects this database knows", () => {
  it("reports the ones that exist and drops the ones that do not", async () => {
    // The guard between a deployed reaper and a `--real` harness run: those create sandboxes on
    // the same E2B account against a database this one has never seen, so their project ids do
    // not resolve here and their sandboxes are none of this deployment's business.
    const { projectId } = await seedProject();
    const stranger = "11111111-2222-4333-8444-555555555555";

    const known = await reconciler.knownProjectIds([projectId, stranger]);

    expect(known).toEqual([projectId]);
  });

  it("asks nothing when there is nothing to ask about", async () => {
    expect(await reconciler.knownProjectIds([])).toEqual([]);
  });
});
