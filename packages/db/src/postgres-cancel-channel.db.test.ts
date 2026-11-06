/**
 * Cancel wake-ups against a real Postgres, where the parts a hub cannot stand in for are.
 *
 * That `LISTEN` on one connection hears `pg_notify` from another; that a worker told about a cancel
 * finds the row already flagged; that the channel adds no backend to the connection budget; and that
 * it comes back after the socket dies. What a worker does with a wake-up is proved against the two
 * real compositions in `apps/api/src/split.db.test.ts`, because this package cannot see a worker.
 *
 * The container is shared across the `db` project, so nothing here may assume a wake-up is its own:
 * every test filters on the request id it made.
 */

import { randomUUID } from "node:crypto";
import { LEASE_RENEWAL_INTERVAL_MS } from "@nap/shared/lease-windows";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { PostgresCancelChannel } from "./postgres-cancel-channel.ts";
import { PostgresNotifyTransport } from "./postgres-notify-transport.ts";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";

const connections: postgres.Sql[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.end();
});

/** One process's pool and listener. `name` is how a test finds its backend in `pg_stat_activity`. */
function replica(name = randomUUID()) {
  const notifier = postgres(inject("postgresUrl"), { max: 2 });
  const listener = postgres(inject("postgresUrl"), {
    max: 1,
    connection: { application_name: name },
  });
  connections.push(notifier, listener);
  const transport = new PostgresNotifyTransport({ notifier, listener });
  return { notifier, name, transport, channel: new PostgresCancelChannel(transport) };
}

async function backendsNamed(sql: postgres.Sql, name: string) {
  return await sql<{ pid: number }[]>`
    select pid from pg_stat_activity where application_name = ${name}
  `;
}

async function seedSession(sql: postgres.Sql) {
  const db = drizzle(sql);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Ada" })
    .returning();
  const userId = user?.id ?? "";
  const { sessionId } = await createProjectSession(db, { userId });
  return { sessionId, userId };
}

describe("PostgresCancelChannel over two connections", () => {
  it("is heard by another process, in far less than a renewal interval", async () => {
    const api = replica();
    const worker = replica();
    const request = randomUUID();
    let heardAt: number | null = null;
    await worker.channel.listen((id) => {
      if (id === request) heardAt = Date.now();
    });

    const sentAt = Date.now();
    api.channel.announce(request);

    // Waited for past the limit below, so a slow wake-up reads as the number it is.
    await expect
      .poll(() => heardAt, { timeout: LEASE_RENEWAL_INTERVAL_MS / 5, interval: 2 })
      .not.toBeNull();
    expect((heardAt ?? 0) - sentAt).toBeLessThan(LEASE_RENEWAL_INTERVAL_MS / 10);
  });

  it("reaches a worker that then finds the row already flagged", async () => {
    // The order the whole design rests on. The worker's only reaction to a wake-up is to read the
    // row, so a wake-up that beat the commit would be read, believed and forgotten.
    const api = replica();
    const worker = replica();
    const apiQueue = new PostgresTurnQueue(drizzle(api.notifier), { claims: null });
    const workerQueue = new PostgresTurnQueue(drizzle(worker.notifier), { claims: null });
    const { sessionId, userId } = await seedSession(api.notifier);
    const id = randomUUID();
    await apiQueue.enqueue({
      id,
      sessionId,
      userId,
      kind: "turn",
      message: "add a toggle",
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });
    // A worker on another pod takes it, and only this request is the one under test: the shared
    // container may hold other tests' queued rows, so the row is leased by id rather than by claim.
    await api.notifier`
      update turn_requests
      set state = 'leased', lease_owner = 'worker-1', lease_expires_at = now() + interval '1 minute'
      where id = ${id}
    `;
    const answers: unknown[] = [];
    await worker.channel.listen((requestId) => {
      if (requestId === id) answers.push(workerQueue.renew(requestId, "worker-1"));
    });

    const outcome = await apiQueue.requestCancel(sessionId);
    if (!outcome.cancelled || outcome.was !== "leased") throw new Error("expected a leased row");
    api.channel.announce(outcome.requestId);

    await expect.poll(() => answers.length, { interval: 2 }).toBe(1);
    await expect(answers[0]).resolves.toEqual({ held: true, cancelRequested: true });
  });

  it("adds no backend to the one the event bus's channels already share", async () => {
    // The connection budget, read from the database's side. postgres.js holds one socket per
    // listening `Sql`, so this channel costs a worker no connection against the pool limits.
    const worker = replica();
    await worker.transport.listen("nap_events", () => {});
    await worker.transport.listen("nap_events_heartbeat", () => {});
    expect(await backendsNamed(worker.notifier, worker.name)).toHaveLength(1);

    await worker.channel.listen(() => {});

    expect(await backendsNamed(worker.notifier, worker.name)).toHaveLength(1);
  });

  it("comes back on its own after the listening socket is killed", async () => {
    // What a wake-up can be lost to, and what stops the loss outlasting the outage: anything sent
    // while the socket is down is gone for good, and the next renewal stands in for it. postgres.js
    // re-issues the `LISTEN`, so later ones are heard again with nothing here doing anything.
    const api = replica();
    const worker = replica();
    const request = randomUUID();
    let heard = 0;
    await worker.channel.listen((id) => {
      if (id === request) heard += 1;
    });
    const [before] = await backendsNamed(worker.notifier, worker.name);

    await worker.notifier`select pg_terminate_backend(${before?.pid ?? 0})`;

    await expect
      .poll(
        async () => {
          api.channel.announce(request);
          return heard;
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBeGreaterThan(0);
    const [after] = await backendsNamed(worker.notifier, worker.name);
    expect(after?.pid).not.toBe(before?.pid);
  });

  it("is sent through the pool, so an announcing process holds no listener at all", async () => {
    const api = replica();
    const worker = replica();
    const request = randomUUID();
    let heard = false;
    await worker.channel.listen((id) => {
      if (id === request) heard = true;
    });

    api.channel.announce(request);

    await expect.poll(() => heard, { interval: 2 }).toBe(true);
    expect(await backendsNamed(worker.notifier, api.name)).toHaveLength(0);
  });
});
