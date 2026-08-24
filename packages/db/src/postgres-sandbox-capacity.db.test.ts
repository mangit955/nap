import { randomUUID } from "node:crypto";
import { eq, sql as sqlOf } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { PostgresCapacityReconciler } from "./postgres-capacity-reconciler.ts";
import { PostgresSandboxCapacity } from "./postgres-sandbox-capacity.ts";
import { projects, sandboxReservations, users } from "./schema.ts";

/**
 * The ceiling that bounds the bill, against a real Postgres — because what is being tested is
 * *atomicity*, and a fake would agree with itself no matter how many callers raced.
 *
 * The interesting assertions all run a burst of admissions at once and count what got in. Before
 * this existed the code counted running sandboxes and then created one, so a hundred simultaneous
 * admissions all read the same number, all decided they were under the limit, and the deployment
 * paid for a hundred sandboxes against a cap of ten.
 *
 * **This file owns the whole table**, unlike the rest of the `db` suite, which is careful to
 * assert only on rows it seeded. A global ceiling counts every row there is, so a test of it
 * cannot be scoped to its own — hence the truncate in `beforeEach`, and hence nothing else in the
 * suite may write to `sandbox_reservations`.
 */

const TOTAL = 10;
const PER_USER = 2;

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let capacity: PostgresSandboxCapacity;

beforeAll(() => {
  // More than one connection, or a burst of concurrent transactions would be serialized by the
  // pool before the advisory lock ever saw them — and the test would pass without testing.
  sql = postgres(inject("postgresUrl"), { max: 16 });
  db = drizzle(sql);
  capacity = new PostgresSandboxCapacity(db, { perUser: PER_USER, total: TOTAL });
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

async function seedProject(userId: string): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ userId, name: "Todo app", slug: `todo-${randomUUID()}` })
    .returning();
  return project?.id ?? "";
}

/** One project each, so nothing is refused for the reason the caps are not about. */
async function seedProjects(count: number, userId?: string): Promise<string[]> {
  const owner = userId ?? (await seedUser());
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await seedProject(owner));
  return ids;
}

function admittedOf(results: Awaited<ReturnType<typeof capacity.reserve>>[]): number {
  return results.filter((result) => result.ok).length;
}

describe("reserving capacity", () => {
  it("admits a project and records it as reserved rather than active", async () => {
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    const reserved = await capacity.reserve({ projectId, userId });
    expect(reserved.ok).toBe(true);

    const rows = await db
      .select()
      .from(sandboxReservations)
      .where(eq(sandboxReservations.projectId, projectId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("reserved");
    // Nothing to name yet: the whole point is that this row exists before the provider is called.
    expect(rows[0]?.sandboxId).toBeNull();
  });

  it("refuses a project whose sandbox somebody else is creating right now", async () => {
    // Two callers each believing they own the creation is how a project ends up with two
    // sandboxes, one of which nothing references and nobody stops paying for.
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    await capacity.reserve({ projectId, userId });
    const second = await capacity.reserve({ projectId, userId });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.reason).toBe("project_held");
  });

  it("hands an active project its own slot back rather than refusing it", async () => {
    // The provider reclaimed the sandbox behind our back, so the row is stale and the project is
    // about to be restored into a new one. Refusing here would leave it unable to open at all
    // until a sweep came past — the one path where a mistake loses somebody's work.
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    const first = await capacity.reserve({ projectId, userId });
    if (!first.ok) throw new Error("expected the first reservation to be admitted");
    await capacity.activate(first.value.id, "sb-reclaimed");

    const again = await capacity.reserve({ projectId, userId });

    expect(again).toMatchObject({ ok: true, value: { id: first.value.id } });
    // The same row, reset to waiting on a creation — so the project held one slot before and
    // holds exactly one now.
    expect(await db.$count(sandboxReservations)).toBe(1);
    const [row] = await db
      .select()
      .from(sandboxReservations)
      .where(eq(sandboxReservations.projectId, projectId));
    expect(row?.state).toBe("reserved");
    expect(row?.sandboxId).toBeNull();
  });

  it("hands an abandoned reservation back once it has expired", async () => {
    // A process that died between reserving and creating. Its row is the only thing still
    // holding the slot, and the project asking again is the same project it was held for.
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    const first = await capacity.reserve({ projectId, userId });
    if (!first.ok) throw new Error("expected the first reservation to be admitted");
    await db
      .update(sandboxReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sandboxReservations.id, first.value.id));

    const again = await capacity.reserve({ projectId, userId });

    expect(again).toMatchObject({ ok: true, value: { id: first.value.id } });
    expect(await db.$count(sandboxReservations)).toBe(1);
  });

  it("refuses once the user is at their own limit", async () => {
    const userId = await seedUser();
    const projectIds = await seedProjects(PER_USER + 1, userId);

    const results = [];
    for (const projectId of projectIds) results.push(await capacity.reserve({ projectId, userId }));

    expect(admittedOf(results)).toBe(PER_USER);
    const last = results.at(-1);
    if (last !== undefined && !last.ok) expect(last.error.reason).toBe("per_user");
  });

  it("refuses once everybody together is at the ceiling", async () => {
    // One project per user, so the per-user cap is never what refuses anything.
    const projectIds: { projectId: string; userId: string }[] = [];
    for (let i = 0; i < TOTAL + 1; i += 1) {
      const userId = await seedUser();
      projectIds.push({ projectId: await seedProject(userId), userId });
    }

    const results = [];
    for (const request of projectIds) results.push(await capacity.reserve(request));

    expect(admittedOf(results)).toBe(TOTAL);
    const last = results.at(-1);
    if (last !== undefined && !last.ok) expect(last.error.reason).toBe("total");
  });
});

describe("under concurrency", () => {
  it("admits exactly the ceiling when a hundred arrive at once", async () => {
    const requests: { projectId: string; userId: string }[] = [];
    for (let i = 0; i < 100; i += 1) {
      const userId = await seedUser();
      requests.push({ projectId: await seedProject(userId), userId });
    }

    const results = await Promise.all(requests.map((request) => capacity.reserve(request)));

    // The assertion the table exists for. Watched failing by dropping the advisory lock from
    // `reserve`, which admits far more than ten.
    expect(admittedOf(results)).toBe(TOTAL);
    expect(await db.$count(sandboxReservations)).toBe(TOTAL);
  });

  it("holds the per-user cap when one user's admissions arrive at once", async () => {
    const userId = await seedUser();
    const projectIds = await seedProjects(8, userId);

    const results = await Promise.all(
      projectIds.map((projectId) => capacity.reserve({ projectId, userId })),
    );

    expect(admittedOf(results)).toBe(PER_USER);
  });

  it("holds the ceiling across two processes sharing one database", async () => {
    // A second pool and a second instance is what a second API pod *is* from the database's
    // point of view: no shared memory, no shared counter, only the rows and the lock.
    const otherSql = postgres(inject("postgresUrl"), { max: 16 });
    const other = new PostgresSandboxCapacity(drizzle(otherSql), {
      perUser: PER_USER,
      total: TOTAL,
    });

    try {
      const requests: { projectId: string; userId: string }[] = [];
      for (let i = 0; i < 30; i += 1) {
        const userId = await seedUser();
        requests.push({ projectId: await seedProject(userId), userId });
      }

      const results = await Promise.all(
        requests.map((request, i) => (i % 2 === 0 ? capacity : other).reserve(request)),
      );

      expect(admittedOf(results)).toBe(TOTAL);
    } finally {
      await otherSql.end();
    }
  });
});

describe("giving capacity back", () => {
  it("frees a reservation whose creation failed, immediately", async () => {
    const userId = await seedUser();
    const projectIds = await seedProjects(PER_USER + 1, userId);

    const held = [];
    for (let i = 0; i < PER_USER; i += 1) {
      const projectId = projectIds[i] ?? "";
      const reserved = await capacity.reserve({ projectId, userId });
      if (reserved.ok) held.push(reserved.value.id);
    }

    const last = projectIds.at(-1) ?? "";
    expect((await capacity.reserve({ projectId: last, userId })).ok).toBe(false);

    await capacity.release(held[0] ?? "");

    // No sweep, no expiry, no waiting: the capacity is back the moment the row goes.
    expect((await capacity.reserve({ projectId: last, userId })).ok).toBe(true);
  });

  it("frees whatever a project holds when it is torn down", async () => {
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    const reserved = await capacity.reserve({ projectId, userId });
    if (reserved.ok) await capacity.activate(reserved.value.id, "sb-1");

    await capacity.releaseForProject(projectId);

    expect(await db.$count(sandboxReservations, eq(sandboxReservations.projectId, projectId))).toBe(
      0,
    );
    // And the project may be admitted again, which is the whole reason a teardown releases.
    expect((await capacity.reserve({ projectId, userId })).ok).toBe(true);
  });

  it("is silent about releasing a reservation that is already gone", async () => {
    // Two teardowns for one project is ordinary — a close racing the reaper — and the second
    // must not fail the caller for finding nothing to do.
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    await expect(capacity.releaseForProject(projectId)).resolves.toBeUndefined();
    await expect(capacity.release(randomUUID())).resolves.toBeUndefined();
  });
});

describe("activating", () => {
  it("records the sandbox and stops the reservation expiring", async () => {
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    const reserved = await capacity.reserve({ projectId, userId });
    if (!reserved.ok) throw new Error("expected the reservation to be admitted");
    await capacity.activate(reserved.value.id, "sb-42");

    const [row] = await db
      .select({
        state: sandboxReservations.state,
        sandboxId: sandboxReservations.sandboxId,
        // Compared in SQL rather than read back: `timestamptz 'infinity'` has no `Date` to
        // become, and the driver hands back an invalid one.
        neverExpires: sqlOf<boolean>`${sandboxReservations.expiresAt} = 'infinity'`,
      })
      .from(sandboxReservations)
      .where(eq(sandboxReservations.id, reserved.value.id));

    expect(row?.state).toBe("active");
    expect(row?.sandboxId).toBe("sb-42");
    // An active row is released by the teardown that destroys its sandbox, never by a clock.
    expect(row?.neverExpires).toBe(true);
  });

  it("reports a reservation the reaper reclaimed while the sandbox was being created", async () => {
    // The whole failure this file exists to stop, in the one shape that needs no crash and no
    // concurrency: a create slower than the reservation's two-minute TTL. The reaper reclaims the
    // row, the create then succeeds, and an `activate` that resolved silently would leave a real,
    // running, billed sandbox that nothing counts — a sandbox outside the ceiling.
    const userId = await seedUser();
    const projectId = await seedProject(userId);

    const reserved = await capacity.reserve({ projectId, userId });
    if (!reserved.ok) throw new Error("expected the reservation to be admitted");

    // A create that ran past the TTL, expressed as the row's own clock rather than by waiting.
    await db
      .update(sandboxReservations)
      .set({ expiresAt: sqlOf`now() - interval '1 second'` })
      .where(eq(sandboxReservations.id, reserved.value.id));
    const reclaimed = await new PostgresCapacityReconciler(db).reclaimStranded();
    expect(reclaimed.expired).toEqual([reserved.value.id]);

    const activated = await capacity.activate(reserved.value.id, "sb-uncounted");

    expect(activated).toMatchObject({ ok: false, error: { reason: "reservation_reclaimed" } });
    // And nothing was resurrected: an insert here would count a slot the ceiling already gave away.
    expect(await db.$count(sandboxReservations)).toBe(0);
  });

  it("keeps occupying capacity once active", async () => {
    const userId = await seedUser();
    const [first = "", second = ""] = await seedProjects(2, userId);

    const reserved = await capacity.reserve({ projectId: first, userId });
    if (reserved.ok) await capacity.activate(reserved.value.id, "sb-1");

    await capacity.reserve({ projectId: second, userId });
    const third = await seedProject(userId);

    const refused = await capacity.reserve({ projectId: third, userId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.reason).toBe("per_user");
  });
});
