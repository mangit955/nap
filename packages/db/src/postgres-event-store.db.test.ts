import { randomUUID } from "node:crypto";
import { type NapEvent, NapEventSchema } from "@nap/shared/events";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { InProcessEventBus } from "./in-process-event-bus.ts";
import { PostgresEventStore } from "./postgres-event-store.ts";
import { projects, sessions, users } from "./schema.ts";
import { expectEventSequence } from "./testing/event-assertions.ts";

/**
 * The store runs against a real Postgres because the two things worth proving about it are
 * things only a database can show: that a hundred concurrent appends still produce a gapless
 * sequence, and that a `timestamptz` column comes back as an ISO string the event contract
 * accepts.
 *
 * The container is shared across the whole `db` project, so nothing here may assume an empty
 * table — every test seeds its own session and asserts only on that session's events.
 */

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresEventStore;

beforeAll(() => {
  // Larger than the default so the 100-parallel test actually overlaps in the database
  // rather than being serialized by the client's connection queue.
  sql = postgres(inject("postgresUrl"), { max: 10 });
  db = drizzle(sql);
  store = new PostgresEventStore(db);
});

afterAll(async () => {
  await sql.end();
});

/** A user → project → session chain, since an event's session id is a foreign key. */
async function seedSession(): Promise<string> {
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
  return session!.id;
}

function message(sessionId: string, turnId: string, text: string): PendingEvent {
  return {
    type: "agent.message",
    sessionId,
    turnId,
    createdAt: new Date().toISOString(),
    payload: { text },
  };
}

describe("append assigns seq", () => {
  it("starts at 1 and increments by one", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    const first = await store.append(message(sessionId, turnId, "one"));
    const second = await store.append(message(sessionId, turnId, "two"));
    const third = await store.append(message(sessionId, turnId, "three"));

    // 1 rather than 0: `readFrom(sessionId, 0)` has to mean "everything", and the port
    // defines it as `seq > afterSeq`.
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  });

  it("counts per session, so two sessions do not share a sequence", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const turnId = randomUUID();

    const a1 = await store.append(message(a, turnId, "a1"));
    const b1 = await store.append(message(b, turnId, "b1"));
    const a2 = await store.append(message(a, turnId, "a2"));
    const b2 = await store.append(message(b, turnId, "b2"));

    expect([a1.seq, a2.seq]).toEqual([1, 2]);
    expect([b1.seq, b2.seq]).toEqual([1, 2]);
  });

  it("returns the event with everything else it was given", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    const stored = await store.append({
      type: "tool.call",
      sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      payload: {
        toolCallId: "call_1",
        toolName: "write_file",
        input: { path: "src/App.tsx", content: "export default () => null;" },
      },
    });

    expect(stored.type).toBe("tool.call");
    expect(stored.sessionId).toBe(sessionId);
    expect(stored.turnId).toBe(turnId);
    expect(stored.payload).toEqual({
      toolCallId: "call_1",
      toolName: "write_file",
      input: { path: "src/App.tsx", content: "export default () => null;" },
    });
  });
});

describe("concurrent appends", () => {
  it("give a hundred parallel writers a gapless sequence with no duplicates", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    // The Done-when criterion for this task. Without a lock, every writer reads the same
    // max(seq) and they collide; the unique index is the database's backstop, but the point
    // is that the code never reaches it.
    const stored = await Promise.all(
      Array.from({ length: 100 }, (_, i) => store.append(message(sessionId, turnId, `n${i}`))),
    );

    const seqs = stored.map((event) => event.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));

    // And the log agrees with what the writers were told.
    const read = await store.readFrom(sessionId, 0);
    expect(read.map((event) => event.seq)).toEqual(seqs);
  });
});

describe("readFrom", () => {
  it("returns exactly the events after the given seq, in order", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();
    for (const text of ["one", "two", "three", "four", "five"]) {
      await store.append(message(sessionId, turnId, text));
    }

    const tail = await store.readFrom(sessionId, 2);

    expect(tail.map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(tail.map((event) => (event.payload as { text: string }).text)).toEqual([
      "three",
      "four",
      "five",
    ]);
  });

  it("returns everything from seq 0 and nothing from beyond the end", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();
    await store.append({
      type: "turn.started",
      sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      payload: {},
    });
    await store.append(message(sessionId, turnId, "done"));

    expectEventSequence(await store.readFrom(sessionId, 0), ["turn.started", "agent.message"]);
    expect(await store.readFrom(sessionId, 2)).toEqual([]);
  });

  it("never returns another session's events", async () => {
    const a = await seedSession();
    const b = await seedSession();
    const turnId = randomUUID();
    await store.append(message(a, turnId, "mine"));
    await store.append(message(b, turnId, "theirs"));

    const read = await store.readFrom(a, 0);
    expect(read).toHaveLength(1);
    expect(read[0]?.sessionId).toBe(a);
  });

  it("is empty for a session with no events", async () => {
    expect(await store.readFrom(await seedSession(), 0)).toEqual([]);
  });
});

describe("what comes back is a NapEvent", () => {
  it("parses, and append and readFrom agree on createdAt", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    // Deliberately not the canonical rendering: the column is timestamptz, so whatever the
    // emitter wrote is normalized on the way through. Both methods must therefore read the
    // timestamp back from the row rather than one of them echoing the caller, or a replayed
    // event would not be byte-identical to the one that was published live.
    const appended = await store.append({
      type: "agent.message",
      sessionId,
      turnId,
      createdAt: "2026-08-09T12:00:00Z",
      payload: { text: "hi" },
    });

    expect(NapEventSchema.safeParse(appended).success).toBe(true);

    const [read] = await store.readFrom(sessionId, 0);
    expect(read).toStrictEqual(appended);
    expect(appended.createdAt).toBe(new Date("2026-08-09T12:00:00Z").toISOString());
  });
});

describe("the store and the bus together", () => {
  it("give a late subscriber a replay that lines up exactly with the live tail", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();
    const bus = new InProcessEventBus();

    // The shape the runtime uses and the WebSocket endpoint will depend on: append first,
    // publish second, so nothing is ever delivered that was not written.
    const emit = async (event: PendingEvent) => bus.publish(await store.append(event));

    await emit(message(sessionId, turnId, "before"));
    await emit(message(sessionId, turnId, "also before"));

    const live: StoredEvent[] = [];
    const replayed = await store.readFrom(sessionId, 0);
    bus.subscribe(sessionId, (event) => live.push(event));

    await emit(message(sessionId, turnId, "after"));

    expect(replayed.map((e) => e.seq)).toEqual([1, 2]);
    expect(live.map((e) => e.seq)).toEqual([3]);
    // No duplicate across the seam, and no gap: a client stitching the two together sees
    // 1, 2, 3 exactly once each.
    expect([...replayed, ...live]).toStrictEqual(await store.readFrom(sessionId, 0));
  });
});

/**
 * One fixture per event type, so the payloads that actually go through `jsonb` are all
 * exercised rather than just the two the other tests happen to use.
 */
const JOB = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";

const PAYLOADS = [
  { type: "user.message", payload: { text: "build me a todo list" } },
  { type: "agent.thinking", payload: { text: "considering the layout" } },
  { type: "agent.message", payload: { text: "Added App.tsx." } },
  {
    type: "tool.call",
    payload: { toolCallId: "call_1", toolName: "read_file", input: { path: "src/App.tsx" } },
  },
  {
    type: "tool.result",
    payload: { toolCallId: "call_1", toolName: "read_file", ok: false, output: "no such file" },
  },
  {
    type: "file.changed",
    payload: { path: "src/App.tsx", changeType: "modified", diff: "@@ -1 +1 @@\n-old\n+new\n" },
  },
  {
    type: "command.output",
    payload: { toolCallId: "call_2", stream: "stderr", chunk: "warning: unused import\n" },
  },
  { type: "preview.ready", payload: { url: "https://5173-abc.e2b.dev", port: 5173 } },
  { type: "turn.started", payload: {} },
  {
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 1200, outputTokens: 340 },
      durationMs: 8400,
      commitSha: "a1b2c3d",
    },
  },
  { type: "turn.failed", payload: { reason: "refusal", message: "declined" } },
  { type: "system.notice", payload: { level: "warning", text: "restored from a snapshot" } },
  { type: "preview.stopped", payload: {} },
  { type: "job.started", payload: { jobId: JOB, objective: "build me a todo list" } },
  { type: "verification.started", payload: { jobId: JOB } },
  {
    type: "verification.completed",
    payload: {
      jobId: JOB,
      checks: [
        { name: "typecheck", outcome: "failed", output: "1 error" },
        // A nested `null` is the case worth round-tripping: `undefined` would be dropped by
        // `jsonb` on the way in and the row would come back a different shape.
        { name: "lint", outcome: "absent", output: null },
      ],
    },
  },
  { type: "job.checkpointed", payload: { jobId: JOB, commitSha: "a1b2c3d" } },
  { type: "job.completed", payload: { jobId: JOB, outcome: "exhausted" } },
] as const satisfies readonly { type: NapEvent["type"]; payload: NapEvent["payload"] }[];

describe("every event type survives the round trip", () => {
  it("covers the whole union", () => {
    const covered = PAYLOADS.map((p) => p.type);
    expect(new Set(covered).size).toBe(covered.length);
    expect(PAYLOADS).toHaveLength(NapEventSchema.options.length);

    // Fails to compile if a new member is added to the union without a fixture here.
    const _exhaustive: (typeof PAYLOADS)[number]["type"] = null as unknown as NapEvent["type"];
    void _exhaustive;
  });

  it.each(PAYLOADS)("$type", async ({ type, payload }) => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    const appended = await store.append({
      type,
      sessionId,
      turnId,
      createdAt: new Date().toISOString(),
      payload,
    } as PendingEvent);

    const [read] = await store.readFrom(sessionId, 0);
    expect(read?.type).toBe(type);
    expect(read?.payload).toEqual(payload);
    expect(read).toStrictEqual(appended);
  });
});
