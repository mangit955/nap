/**
 * The notify bus against a real Postgres, where the parts a fake cannot stand in for are.
 *
 * Three claims need a database rather than a hub: that `LISTEN` on one connection hears
 * `pg_notify` from another *process*, that a rolled-back append announces nothing because
 * `publish` was never reached, and that a session-mode connection is what makes the first one
 * true. The cursor bookkeeping is proved without a container in the unit suite beside this.
 *
 * The container is shared across the `db` project, so each test seeds its own session and
 * asserts only on that session's events — every replica here hears every other test's traffic.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresEventStore } from "./postgres-event-store.ts";
import { PostgresNotifyEventBus } from "./postgres-notify-event-bus.ts";
import { PostgresNotifyTransport } from "./postgres-notify-transport.ts";
import { events, projects, sessions, users } from "./schema.ts";

let sql: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresEventStore;

/** Every connection a test opened, so nothing keeps the suite alive after it. */
const connections: postgres.Sql[] = [];
const buses: PostgresNotifyEventBus[] = [];

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 5 });
  db = drizzle(sql);
  store = new PostgresEventStore(db);
});

afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.stop();
  for (const connection of connections.splice(0)) await connection.end();
});

afterAll(async () => {
  await sql.end();
});

/**
 * One process: its own pool, its own listener connection, its own bus.
 *
 * Separate pools rather than a shared one because that is the thing being tested — two
 * processes, each with a `LISTEN` of its own, hearing an event neither of them appended.
 */
async function replica(options: { now?: () => number } = {}): Promise<PostgresNotifyEventBus> {
  const notifier = postgres(inject("postgresUrl"), { max: 2 });
  const listener = postgres(inject("postgresUrl"), { max: 1 });
  connections.push(notifier, listener);

  const bus = new PostgresNotifyEventBus({
    reader: new PostgresEventStore(drizzle(notifier)),
    transport: new PostgresNotifyTransport({ notifier, listener }),
    // Long enough that nothing in here is delivered by the poll unless the test calls `tick`,
    // and long enough that no background timer fires during a test.
    pollIntervalMs: 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await bus.start();
  buses.push(bus);
  return bus;
}

async function seedSession(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  const [project] = await db
    .insert(projects)
    .values({ userId: user?.id ?? "", name: "Todo app", slug: `todo-${randomUUID()}` })
    .returning();
  const [session] = await db
    .insert(sessions)
    .values({ projectId: project?.id ?? "", title: "First session" })
    .returning();
  return session?.id ?? "";
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

/**
 * A notification is a real round trip through the database, so a subscriber cannot be checked
 * on the next microtask. Polled rather than slept on a fixed number, so a fast machine is fast.
 */
async function eventually(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
}

describe("events crossing a process boundary", () => {
  it("delivers to two processes, neither of which appended the event", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    const worker = await replica();
    const socketA = await replica();
    const socketB = await replica();

    const first: StoredEvent[] = [];
    const second: StoredEvent[] = [];
    socketA.subscribe(sessionId, (event) => first.push(event));
    socketB.subscribe(sessionId, (event) => second.push(event));
    // Establishes both cursors before anything is appended.
    await Promise.all([socketA.tick(), socketB.tick()]);

    const one = await store.append(message(sessionId, turnId, "one"));
    worker.publish(one);
    const two = await store.append(message(sessionId, turnId, "two"));
    worker.publish(two);

    await eventually(() => first.length === 2 && second.length === 2);

    expect(first).toStrictEqual([one, two]);
    expect(second).toStrictEqual([one, two]);
  });

  it("delivers nothing for an append that rolled back", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    const worker = await replica();
    const socket = await replica();

    const received: StoredEvent[] = [];
    socket.subscribe(sessionId, (event) => received.push(event));
    await socket.tick();

    // A failing transaction, in the shape `append` uses one. `publish` is unreachable from
    // here — `EventSink` records the failure and stops the chain — which is the whole reason
    // `pg_notify` is not inside the append transaction.
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(events)
          .values({
            sessionId,
            turnId,
            seq: 1,
            type: "agent.message",
            payload: { text: "never committed" },
            createdAt: new Date(),
          })
          .returning();
        throw new Error("the turn failed");
      }),
    ).rejects.toThrow("the turn failed");

    // Long enough that a notification sent inside that transaction would have arrived.
    await sleep(200);
    // And the poll would find it too, if the row were there.
    await socket.tick();
    await worker.tick();

    expect(received).toEqual([]);
    expect(await store.readFrom(sessionId, 0)).toEqual([]);
  });

  it("catches up on an event nobody announced", async () => {
    const sessionId = await seedSession();
    const turnId = randomUUID();

    const socket = await replica();
    const received: StoredEvent[] = [];
    socket.subscribe(sessionId, (event) => received.push(event));
    await socket.tick();

    // Appended and never published: a worker that died between the commit and the notify.
    const orphan = await store.append(message(sessionId, turnId, "unannounced"));
    expect(received).toEqual([]);

    await socket.tick();

    expect(received).toStrictEqual([orphan]);
  });

  it("hears its own heartbeat over a real listener connection", async () => {
    let clock = 1000;
    const bus = await replica({ now: () => clock });

    // Far enough past the echo `start` credits itself with that only a *fresh* one can answer.
    // Without this the assertion below would pass against a listener that never delivered
    // anything at all, which is the failure it exists to catch.
    clock += 200_000;
    expect(bus.listening).toBe(false);

    await bus.tick();
    await eventually(() => bus.listening);

    expect(bus.listening).toBe(true);
  });
});
