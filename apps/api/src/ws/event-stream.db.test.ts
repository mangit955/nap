/**
 * One client's stream, over the bus that crosses process boundaries and a real Postgres.
 *
 * The unit suite beside this proves the replay seam against a synchronous, in-process bus:
 * subscribe, buffer, read, flush, tail. `PostgresNotifyEventBus` changes the one assumption
 * that suite bakes in — delivery is now a round trip through the database rather than a
 * function call — so the property everybody actually depends on is worth re-proving over the
 * real thing. **A client reconnecting at an arbitrary `seq`, while a turn on another process is
 * mid-flight, sees every event after that `seq` exactly once and in order.**
 *
 * Two processes, deliberately: the turn appends and announces on one, the socket is served by
 * the other, and neither shares an emitter with the other. That is the arrangement one replica
 * never exercises and every replica after the first depends on.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresNotifyEventBus } from "@nap/db/postgres-notify-event-bus";
import { PostgresNotifyTransport } from "@nap/db/postgres-notify-transport";
import { projects, sessions, users } from "@nap/db/schema";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { type ServerFrame, ServerFrameSchema } from "@nap/shared/ws-protocol";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { openEventStream } from "./event-stream.ts";

const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

class FakeSocket {
  readonly sent: string[] = [];

  readonly send = (data: string): void => {
    this.sent.push(data);
  };

  readonly close = (): void => {};

  get frames(): ServerFrame[] {
    return this.sent.map((raw) => ServerFrameSchema.parse(JSON.parse(raw)));
  }

  get seqs(): number[] {
    return this.frames.flatMap((frame) => (frame.type === "event" ? [frame.event.seq] : []));
  }
}

let sql: postgres.Sql;
const connections: postgres.Sql[] = [];
const buses: PostgresNotifyEventBus[] = [];

beforeAll(() => {
  sql = postgres(inject("postgresUrl"), { max: 5 });
});

afterEach(async () => {
  for (const bus of buses.splice(0)) await bus.stop();
  for (const connection of connections.splice(0)) await connection.end();
});

afterAll(async () => {
  await sql.end();
});

/** One process: its own pool, its own session-mode listener, its own bus. */
async function replica(): Promise<{ bus: PostgresNotifyEventBus; store: PostgresEventStore }> {
  const notifier = postgres(inject("postgresUrl"), { max: 2 });
  const listener = postgres(inject("postgresUrl"), { max: 1 });
  connections.push(notifier, listener);

  const own = new PostgresEventStore(drizzle(notifier));
  const bus = new PostgresNotifyEventBus({
    reader: own,
    transport: new PostgresNotifyTransport({ notifier, listener }),
    // Short, because the reconnect this tests is exactly the window a lost notification lands
    // in — the poll being the backstop needs to be the *tested* backstop, not a documented one.
    pollIntervalMs: 250,
  });
  await bus.start();
  buses.push(bus);
  return { bus, store: own };
}

async function seedSession(): Promise<string> {
  const db = drizzle(sql);
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

function message(sessionId: string, text: string): PendingEvent {
  return {
    type: "agent.message",
    sessionId,
    turnId: TURN,
    createdAt: new Date().toISOString(),
    payload: { text },
  };
}

async function eventually(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
}

describe("a socket served by a process that is not running the turn", () => {
  it("reconnecting mid-stream at an arbitrary seq yields no gaps and no duplicates", async () => {
    const sessionId = await seedSession();
    const worker = await replica();
    const socketProcess = await replica();

    /** Append and announce, in the order `EventSink` does it. */
    const emit = async (text: string): Promise<StoredEvent> => {
      const stored = await worker.store.append(message(sessionId, text));
      worker.bus.publish(stored);
      return stored;
    };

    for (let i = 1; i <= 6; i++) await emit(`before the reconnect ${i}`);

    // The client last heard seq 4 — two behind the log, which is the state a dropped
    // connection leaves it in — and comes back on the *other* process.
    const socket = new FakeSocket();
    const stream = openEventStream({
      store: socketProcess.store,
      bus: socketProcess.bus,
      sessionId,
      afterSeq: 4,
      socket,
      heartbeat: { intervalMs: 60_000, timeoutMs: 600_000 },
    });

    // The turn keeps going while the replay query is in flight, which is the window the
    // subscribe-then-read ordering exists for.
    for (let i = 7; i <= 12; i++) await emit(`during and after the reconnect ${i}`);
    await stream.ready;

    await eventually(() => socket.seqs.at(-1) === 12);
    stream.onClose();

    expect(socket.seqs).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("delivers a turn's events to a socket whose process announced nothing", async () => {
    const sessionId = await seedSession();
    const worker = await replica();
    const socketProcess = await replica();

    const socket = new FakeSocket();
    const stream = openEventStream({
      store: socketProcess.store,
      bus: socketProcess.bus,
      sessionId,
      afterSeq: 0,
      socket,
      heartbeat: { intervalMs: 60_000, timeoutMs: 600_000 },
    });
    await stream.ready;

    for (let i = 1; i <= 3; i++) {
      worker.bus.publish(await worker.store.append(message(sessionId, `turn event ${i}`)));
    }

    await eventually(() => socket.seqs.length === 3);
    stream.onClose();

    // The claim `InProcessEventBus` cannot make: the chat moves for a client connected to a
    // process that is not the one running the turn.
    expect(socket.seqs).toEqual([1, 2, 3]);
  });
});
