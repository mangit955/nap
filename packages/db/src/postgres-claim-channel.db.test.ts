/**
 * Claim wake-ups against a real Postgres: a `pg_notify` sent through one process's pool is heard
 * on another process's `LISTEN` connection, and adds no backend to the one the other channels
 * already share. What a worker does with one is `packages/runtime/src/turn-worker-wakeups.test.ts`.
 *
 * Nothing else in the `db` project sends on this channel — the stores' own tests hand them a
 * recording announcer rather than this — so a wake-up heard here is the one this file sent.
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { PostgresClaimChannel } from "./postgres-claim-channel.ts";
import { PostgresNotifyTransport } from "./postgres-notify-transport.ts";

const connections: postgres.Sql[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.end();
});

function replica(name = randomUUID()) {
  const notifier = postgres(inject("postgresUrl"), { max: 2 });
  const listener = postgres(inject("postgresUrl"), {
    max: 1,
    connection: { application_name: name },
  });
  connections.push(notifier, listener);
  const transport = new PostgresNotifyTransport({ notifier, listener });
  return { notifier, name, transport, channel: new PostgresClaimChannel(transport) };
}

async function backendsNamed(sql: postgres.Sql, name: string) {
  return await sql<{ pid: number }[]>`
    select pid from pg_stat_activity where application_name = ${name}
  `;
}

describe("PostgresClaimChannel over two connections", () => {
  it("is heard by another process, in far less than the fallback poll", async () => {
    const api = replica();
    const worker = replica();
    let heardAt: number | null = null;
    await worker.channel.listen(() => {
      heardAt ??= Date.now();
    });

    const sentAt = Date.now();
    api.channel.announce();

    await expect.poll(() => heardAt, { timeout: 2_000, interval: 2 }).not.toBeNull();
    expect((heardAt ?? 0) - sentAt).toBeLessThan(500);
  });

  it("is not heard once the listener has stopped", async () => {
    const api = replica();
    const worker = replica();
    let heard = 0;
    const stop = await worker.channel.listen(() => heard++);
    await stop();

    api.channel.announce();
    // Long enough for a notification on a local socket to have landed many times over.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(heard).toBe(0);
  });

  it("adds no backend to the one the event bus and the cancel channel already share", async () => {
    const worker = replica();
    await worker.transport.listen("nap_events", () => {});
    await worker.transport.listen("nap_cancel", () => {});
    expect(await backendsNamed(worker.notifier, worker.name)).toHaveLength(1);

    await worker.channel.listen(() => {});

    expect(await backendsNamed(worker.notifier, worker.name)).toHaveLength(1);
  });
});
