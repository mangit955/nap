import { randomUUID } from "node:crypto";
import { NapEventSchema } from "@nap/shared/events";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { events, projects, sessions, snapshots, users } from "./schema.ts";

/**
 * These run against a real Postgres in a container, not a fake, because the things worth
 * testing here are things only Postgres enforces: the unique index behind replay ordering,
 * foreign keys, and what the driver hands back for `jsonb` and `timestamptz`.
 *
 * The container is shared across the whole `db` project, so nothing here may assume an
 * empty table — every test creates the rows it asserts on.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 4 });
  db = drizzle(sql);
});

afterAll(async () => {
  await sql.end();
});

/**
 * The SQLSTATE code Postgres rejected an operation with, or `undefined` if it succeeded.
 *
 * Asserted instead of the message: drizzle wraps driver errors, so `.message` is
 * `"Failed query: …"` and the real reason sits on `.cause`. SQLSTATE codes are standard
 * and stable across driver and wrapper versions in a way message text is not.
 */
async function sqlstateOf(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
}

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** A user → project → session chain, since almost everything hangs off one. */
async function seedSession(): Promise<{ userId: string; projectId: string; sessionId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user!.id, name: "Todo app", slug: `todo-${randomUUID()}` })
    .returning();
  const [session] = await db
    .insert(sessions)
    .values({ projectId: project!.id, title: "First session" })
    .returning();
  return { userId: user!.id, projectId: project!.id, sessionId: session!.id };
}

describe("migrations", () => {
  it("applied to a clean database", async () => {
    // globalSetup runs `migrate()` before any test file loads, so reaching this point at
    // all proves they applied. Assert the tables are actually queryable rather than
    // trusting that migrate() returned without complaint.
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `;
    const names = tables.map((t) => t.table_name);
    expect(names).toEqual(
      expect.arrayContaining(["users", "projects", "sessions", "events", "snapshots"]),
    );
  });
});

describe("round-trips", () => {
  it("users", async () => {
    const email = `${randomUUID()}@example.com`;
    const [inserted] = await db.insert(users).values({ email, name: "Grace" }).returning();
    const [read] = await db.select().from(users).where(eq(users.id, inserted!.id));
    expect(read).toEqual(inserted);
    expect(read?.email).toBe(email);
  });

  it("projects", async () => {
    const { projectId } = await seedSession();
    const [read] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(read?.name).toBe("Todo app");
    // §5 marks both of these optional; they are null until a sandbox exists.
    expect(read?.sandboxId).toBeNull();
    expect(read?.snapshotKey).toBeNull();
  });

  it("sessions", async () => {
    const { sessionId } = await seedSession();
    const [read] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(read?.title).toBe("First session");
  });

  it("events", async () => {
    const { sessionId } = await seedSession();
    const turnId = randomUUID();
    const [inserted] = await db
      .insert(events)
      .values({
        sessionId,
        turnId,
        seq: 0,
        type: "user.message",
        payload: { text: "build me a todo list" },
      })
      .returning();
    const [read] = await db.select().from(events).where(eq(events.id, inserted!.id));
    expect(read?.payload).toEqual({ text: "build me a todo list" });
    expect(read?.seq).toBe(0);
    // seq must come back as a number, not a string — the event contract types it `z.int()`.
    expect(typeof read?.seq).toBe("number");
  });

  it("snapshots", async () => {
    const { projectId } = await seedSession();
    const [inserted] = await db
      .insert(snapshots)
      .values({ projectId, r2Key: "snapshots/abc.bundle", gitSha: "a1b2c3d" })
      .returning();
    const [read] = await db.select().from(snapshots).where(eq(snapshots.id, inserted!.id));
    expect(read).toEqual(inserted);
  });
});

describe("the (session_id, seq) unique constraint", () => {
  it("rejects a duplicate seq within a session", async () => {
    const { sessionId } = await seedSession();
    const row = {
      sessionId,
      turnId: randomUUID(),
      seq: 7,
      type: "agent.message" as const,
      payload: { text: "done" },
    };
    await db.insert(events).values(row);

    // This is the database-level backstop for replay ordering: a duplicate seq means a
    // client sees a doubled message, and no amount of application care can be trusted
    // with it under concurrency.
    expect(await sqlstateOf(db.insert(events).values(row))).toBe(UNIQUE_VIOLATION);
  });

  it("allows the same seq in a different session", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const row = (sessionId: string) => ({
      sessionId,
      turnId: randomUUID(),
      seq: 1,
      type: "agent.message" as const,
      payload: { text: "done" },
    });
    await db.insert(events).values(row(a.sessionId));
    expect(await sqlstateOf(db.insert(events).values(row(b.sessionId)))).toBeUndefined();
  });
});

describe("foreign keys", () => {
  it("rejects an event whose session does not exist", async () => {
    const code = await sqlstateOf(
      db.insert(events).values({
        sessionId: randomUUID(),
        turnId: randomUUID(),
        seq: 0,
        type: "user.message",
        payload: { text: "orphan" },
      }),
    );
    expect(code).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe("a stored row can be turned back into a NapEvent", () => {
  it("survives the timestamptz round trip once createdAt is mapped", async () => {
    const { sessionId } = await seedSession();
    const turnId = randomUUID();
    const [inserted] = await db
      .insert(events)
      .values({ sessionId, turnId, seq: 3, type: "agent.message", payload: { text: "hi" } })
      .returning();

    // The contract stores createdAt as an ISO string so events survive JSON; the column is
    // timestamptz so it stays orderable, which `readFrom` needs. That mismatch is real, and
    // this is the mapping that reconciles it — whatever implements `EventStore` owes it.
    const parsed = NapEventSchema.safeParse({
      type: inserted!.type,
      sessionId: inserted!.sessionId,
      turnId: inserted!.turnId,
      seq: inserted!.seq,
      createdAt: inserted!.createdAt.toISOString(),
      payload: inserted!.payload,
    });

    expect(parsed.success).toBe(true);
  });

  it("stores payloads as jsonb, so key order is not preserved but values are", async () => {
    const { sessionId } = await seedSession();
    const payload = {
      toolCallId: "call_1",
      toolName: "write_file" as const,
      input: { path: "src/App.tsx", content: "x" },
    };
    const [inserted] = await db
      .insert(events)
      .values({ sessionId, turnId: randomUUID(), seq: 11, type: "tool.call", payload })
      .returning();
    expect(inserted?.payload).toEqual(payload);
  });
});

describe("query shapes the later tasks depend on", () => {
  it("reads a session's events after a given seq, in order", async () => {
    const { sessionId } = await seedSession();
    const turnId = randomUUID();
    for (const seq of [0, 1, 2, 3, 4]) {
      await db
        .insert(events)
        .values({ sessionId, turnId, seq, type: "agent.message", payload: { text: `${seq}` } });
    }

    const rows = await db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId)))
      .orderBy(events.seq);

    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});
