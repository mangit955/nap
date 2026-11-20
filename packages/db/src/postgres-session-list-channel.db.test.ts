/**
 * Session list notices against a real Postgres: a writer on one process names a project, a session
 * or a user, and another process's `LISTEN` hears that owner's id — which is the whole of how a
 * change written on a worker reaches a tab whose socket is on an API pod. And the channel costs no
 * connection beyond the one the event bus already holds.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { PostgresNotifyTransport } from "./postgres-notify-transport.ts";
import {
  PostgresSessionListChannel,
  SESSION_LIST_CHANNEL,
} from "./postgres-session-list-channel.ts";
import { users } from "./schema.ts";
import { createProjectSession } from "./session-bootstrap.ts";

const connections: postgres.Sql[] = [];
let setup: postgres.Sql;
let db: PostgresJsDatabase;
let owner: string;

beforeAll(async () => {
  setup = postgres(inject("postgresUrl"), { max: 2 });
  db = drizzle(setup);
  const [user] = await db
    .insert(users)
    .values({ email: `${randomUUID()}@example.com`, name: "Owner" })
    .returning();
  owner = user?.id ?? "";
});

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.end();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, owner));
  await setup.end();
});

/** One process: its pool, its own `LISTEN` connection, and the channel over them. */
function replica(name = randomUUID()) {
  const notifier = postgres(inject("postgresUrl"), { max: 2 });
  const listener = postgres(inject("postgresUrl"), {
    max: 1,
    connection: { application_name: name },
  });
  connections.push(notifier, listener);
  const transport = new PostgresNotifyTransport({ notifier, listener });
  return {
    name,
    notifier,
    transport,
    channel: new PostgresSessionListChannel(drizzle(notifier), transport),
  };
}

/** Collects what one process hears for `owner`, ignoring anything else on the shared container. */
async function hearing(target: ReturnType<typeof replica>) {
  const heard: string[] = [];
  await target.channel.listen((userId) => {
    if (userId === owner) heard.push(userId);
  });
  return heard;
}

describe("PostgresSessionListChannel over two processes", () => {
  it("delivers the owner of a project, a session or a user to another process", async () => {
    const worker = replica();
    const api = replica();
    const heard = await hearing(api);
    const { projectId, sessionId } = await createProjectSession(db, { userId: owner });

    const sentAt = Date.now();
    worker.channel.announce({ projectId });
    await expect.poll(() => heard.length, { timeout: 2_000, interval: 2 }).toBe(1);
    expect(Date.now() - sentAt).toBeLessThan(500);

    worker.channel.announce({ sessionId });
    await expect.poll(() => heard.length, { timeout: 2_000, interval: 2 }).toBe(2);
    worker.channel.announce({ userId: owner });
    await expect.poll(() => heard.length, { timeout: 2_000, interval: 2 }).toBe(3);
  });

  it("sends one notice per owner, however many of their rows one write names", async () => {
    const worker = replica();
    const api = replica();
    const heard = await hearing(api);
    const first = await createProjectSession(db, { userId: owner });
    const second = await createProjectSession(db, { userId: owner });

    worker.channel.announce(
      { projectId: first.projectId },
      { sessionId: second.sessionId },
      { userId: owner },
    );
    await expect.poll(() => heard.length, { timeout: 2_000, interval: 2 }).toBe(1);
    // Long enough for a second notification on a local socket to have landed many times over.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heard).toHaveLength(1);
  });

  it("announces nothing for a project that is gone, and never throws to the writer", async () => {
    const worker = replica();
    const api = replica();
    const heard = await hearing(api);

    expect(() => worker.channel.announce({ projectId: randomUUID() })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(heard).toEqual([]);
  });

  it("says whether it is hearing as it was told, and assumes so when nobody said", async () => {
    let listening = true;
    const target = replica();
    const told = new PostgresSessionListChannel(drizzle(target.notifier), target.transport, {
      hearing: () => listening,
    });

    expect(target.channel.hearing()).toBe(true);
    expect(told.hearing()).toBe(true);
    listening = false;
    expect(told.hearing()).toBe(false);
  });

  it("says notices were missed when its listener comes back from a drop", async () => {
    // A drop shorter than the event bus's echo notices is otherwise invisible: postgres.js listens
    // again by itself, and whatever was announced in between is simply gone.
    const api = replica();
    let missed = 0;
    await api.channel.listen(
      () => {},
      () => missed++,
    );
    expect(missed).toBe(0);

    await setup`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${api.name}`;

    await expect.poll(() => missed, { timeout: 15_000, interval: 50 }).toBe(1);
  });

  it("ignores a payload that is not a user id", async () => {
    const api = replica();
    let heard = 0;
    await api.channel.listen(() => heard++);

    await replica().transport.notify(SESSION_LIST_CHANNEL, "not-a-user");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(heard).toBe(0);
  });

  it("adds no backend to the one the event bus and the other channels already share", async () => {
    const api = replica();
    await api.transport.listen("nap_events", () => {});
    await api.transport.listen("nap_claimable", () => {});
    const backends = async () =>
      await api.notifier`select pid from pg_stat_activity where application_name = ${api.name}`;
    expect(await backends()).toHaveLength(1);

    await api.channel.listen(() => {});

    expect(await backends()).toHaveLength(1);
  });
});
