/**
 * The bookkeeping half of the notify bus: cursors, the catch-up poll, and who hears what.
 *
 * Postgres is stood in for by `NotifyHub` and `InMemoryEventStore`, which is not a shortcut —
 * the mistakes this class can make are all about *when* it reads and how far, and a container
 * would make them slower to provoke rather than easier. What genuinely needs a database is in
 * `postgres-notify-event-bus.db.test.ts`.
 */

import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresNotifyEventBus } from "./postgres-notify-event-bus.ts";
import { InMemoryEventStore } from "./testing/in-memory-event-store.ts";
import { NotifyHub } from "./testing/in-memory-notify-transport.ts";

const SESSION_A = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const SESSION_B = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function pending(sessionId: string, text: string): PendingEvent {
  return {
    type: "agent.message",
    sessionId,
    turnId: TURN,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { text },
  };
}

/** One process: its own bus, over the shared hub and the shared log. */
type Replica = { bus: PostgresNotifyEventBus; received: (sessionId: string) => StoredEvent[] };

const running: PostgresNotifyEventBus[] = [];

async function replica(
  hub: NotifyHub,
  store: InMemoryEventStore,
  options: { pollIntervalMs?: number; now?: () => number } = {},
): Promise<Replica> {
  const bus = new PostgresNotifyEventBus({
    reader: store,
    transport: hub.connect(),
    // Long enough that no test is racing a real timer: every poll in here is driven by `tick`.
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  await bus.start();
  running.push(bus);

  const inboxes = new Map<string, StoredEvent[]>();
  return {
    bus,
    received: (sessionId) => {
      const inbox = inboxes.get(sessionId) ?? [];
      if (!inboxes.has(sessionId)) {
        inboxes.set(sessionId, inbox);
        bus.subscribe(sessionId, (event) => inbox.push(event));
      }
      return inbox;
    },
  };
}

/** Append and announce, in the order `EventSink` does it. */
async function emit(
  store: InMemoryEventStore,
  bus: PostgresNotifyEventBus,
  event: PendingEvent,
): Promise<StoredEvent> {
  const stored = await store.append(event);
  bus.publish(stored);
  return stored;
}

/** The bus reads on its own promise chain; `tick` is the point at which it has caught up. */
async function settle(...buses: PostgresNotifyEventBus[]): Promise<void> {
  for (const bus of buses) await bus.tick();
}

afterEach(async () => {
  for (const bus of running.splice(0)) await bus.stop();
});

describe("fanout over a notification channel", () => {
  it("delivers an announced event to a subscriber of that session", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);
    const inbox = received(SESSION_A);

    const stored = await emit(store, bus, pending(SESSION_A, "hello"));
    await settle(bus);

    expect(inbox).toEqual([stored]);
  });

  it("delivers nothing to a subscriber of another session", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);
    const other = received(SESSION_B);
    received(SESSION_A);

    await emit(store, bus, pending(SESSION_A, "hello"));
    await settle(bus);

    expect(other).toEqual([]);
  });

  it("delivers events across a process boundary, to both processes, without duplicating", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const worker = await replica(hub, store);
    const socketA = await replica(hub, store);
    const socketB = await replica(hub, store);

    const first = socketA.received(SESSION_A);
    const second = socketB.received(SESSION_A);
    await settle(socketA.bus, socketB.bus);

    // The turn runs on a process with no sockets on it at all — the case `InProcessEventBus`
    // gets wrong, and the reason this class exists.
    const one = await emit(store, worker.bus, pending(SESSION_A, "one"));
    const two = await emit(store, worker.bus, pending(SESSION_A, "two"));
    await settle(socketA.bus, socketB.bus);

    expect(first).toEqual([one, two]);
    expect(second).toEqual([one, two]);
  });

  it("does not replay the log to a subscriber that joined after it", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);

    await store.append(pending(SESSION_A, "before anyone was watching"));
    const inbox = received(SESSION_A);
    await settle(bus);

    const after = await emit(store, bus, pending(SESSION_A, "after"));
    await settle(bus);

    // History is `openEventStream`'s job, from the client's own `seq`. A bus that also handed
    // it over would be the second copy the `lastSentSeq` gate exists to make impossible.
    expect(inbox).toEqual([after]);
  });

  it("delivers an event appended before the cursor was established", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);

    // Subscribing starts a query for where the log ends. This event lands while that query is
    // in flight, so the head it returns already includes it — and the notification's own `seq`
    // is what stops it being read as history and skipped.
    const inbox = received(SESSION_A);
    const racing = await emit(store, bus, pending(SESSION_A, "raced the head query"));
    await settle(bus);

    expect(inbox).toEqual([racing]);
  });

  it("stops delivering once unsubscribed", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus } = await replica(hub, store);

    const inbox: StoredEvent[] = [];
    const unsubscribe = bus.subscribe(SESSION_A, (event) => inbox.push(event));
    await settle(bus);
    unsubscribe();

    await emit(store, bus, pending(SESSION_A, "nobody is listening"));
    await settle(bus);

    expect(inbox).toEqual([]);
  });

  it("survives a subscriber that unsubscribes from inside its own handler", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);
    const staying = received(SESSION_A);

    const leaving: StoredEvent[] = [];
    const unsubscribe = bus.subscribe(SESSION_A, (event) => {
      leaving.push(event);
      unsubscribe();
    });
    await settle(bus);

    const first = await emit(store, bus, pending(SESSION_A, "one"));
    await settle(bus);
    const second = await emit(store, bus, pending(SESSION_A, "two"));
    await settle(bus);

    expect(leaving).toEqual([first]);
    expect(staying).toEqual([first, second]);
  });
});

describe("the catch-up poll", () => {
  it("delivers events whose notifications were lost entirely", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);
    const inbox = received(SESSION_A);
    await settle(bus);

    hub.suppress();
    const one = await emit(store, bus, pending(SESSION_A, "one"));
    const two = await emit(store, bus, pending(SESSION_A, "two"));

    // Nothing arrived, because nothing was announced. This is the state a process is in after
    // a worker died between committing an append and sending its notification.
    expect(inbox).toEqual([]);

    await settle(bus);

    expect(inbox).toEqual([one, two]);
    // And the wake-ups really were sent and really were dropped — otherwise this test would
    // pass just as well against a bus that never notifies at all.
    expect(hub.sent).toBeGreaterThan(0);
  });

  it("delivers a lost notification to a process that produced none of the events", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const worker = await replica(hub, store);
    const socket = await replica(hub, store);
    const inbox = socket.received(SESSION_A);
    await settle(socket.bus);

    hub.suppress();
    const stored = await emit(store, worker.bus, pending(SESSION_A, "unannounced"));
    await settle(socket.bus);

    expect(inbox).toEqual([stored]);
  });

  it("does not deliver anything twice when a notification and a poll overlap", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    const { bus, received } = await replica(hub, store);
    const inbox = received(SESSION_A);
    await settle(bus);

    const stored = await emit(store, bus, pending(SESSION_A, "announced and polled"));
    await settle(bus);
    await settle(bus);
    await settle(bus);

    expect(inbox).toEqual([stored]);
  });

  it("asks for every subscribed session in one read", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    let reads = 0;
    const counting = {
      headSeq: (sessionId: string) => store.headSeq(sessionId),
      readTails: (cursors: ReadonlyMap<string, number>) => {
        reads += 1;
        return store.readTails(cursors);
      },
    };

    const bus = new PostgresNotifyEventBus({
      reader: counting,
      transport: hub.connect(),
      pollIntervalMs: 60_000,
    });
    await bus.start();
    running.push(bus);

    const inboxes = [SESSION_A, SESSION_B].map((sessionId) => {
      const inbox: StoredEvent[] = [];
      bus.subscribe(sessionId, (event) => inbox.push(event));
      return inbox;
    });
    await bus.tick();

    hub.suppress();
    await store.append(pending(SESSION_A, "a"));
    await store.append(pending(SESSION_B, "b"));

    reads = 0;
    await bus.tick();

    // Two sessions, one query. At a hundred it is still one query — which is the point, and
    // the thing a per-session `readFrom` loop would quietly get wrong. See design §24, item 2.
    expect(reads).toBe(1);
    expect(inboxes.map((inbox) => inbox.length)).toEqual([1, 1]);
  });
});

describe("whether the listener is still hearing anything", () => {
  it("is not listening before it has started", async () => {
    const hub = new NotifyHub();
    const bus = new PostgresNotifyEventBus({
      reader: new InMemoryEventStore(),
      transport: hub.connect(),
    });

    expect(bus.listening).toBe(false);
  });

  it("hears its own heartbeat, and stops when the channel does", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    let clock = 1_000;
    const { bus } = await replica(hub, store, { pollIntervalMs: 100, now: () => clock });

    await bus.tick();
    expect(bus.listening).toBe(true);

    // The channel dies. Nothing errors, nothing closes — the process simply stops hearing
    // itself, which is exactly what a `LISTEN` connection returned to a transaction pooler
    // looks like from the inside.
    hub.suppress();
    await bus.tick();
    clock += 1_000;
    await bus.tick();

    expect(bus.listening).toBe(false);
  });

  it("recovers once the channel does", async () => {
    const hub = new NotifyHub();
    const store = new InMemoryEventStore();
    let clock = 1_000;
    const { bus } = await replica(hub, store, { pollIntervalMs: 100, now: () => clock });

    hub.suppress();
    clock += 1_000;
    await bus.tick();
    expect(bus.listening).toBe(false);

    hub.resume();
    await bus.tick();

    expect(bus.listening).toBe(true);
  });
});
