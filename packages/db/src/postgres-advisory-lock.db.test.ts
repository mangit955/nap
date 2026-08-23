import postgres from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
import { PostgresAdvisoryLock } from "./postgres-advisory-lock.ts";

/**
 * The lock against a real Postgres, because there is nothing else to test it against: what is
 * being asserted is that a *second connection* is refused, and a fake would be asserting that a
 * boolean in this process is false.
 *
 * Every instance gets its own connection, exactly as two reaper processes would. Sharing one would
 * make every `held()` true — advisory locks are re-entrant within a session — which is precisely
 * the failure this file exists to catch.
 */

const connections: postgres.Sql[] = [];
const locks: PostgresAdvisoryLock[] = [];

/** One reaper process: its own connection, its own lock object, the same key. */
function reaper(name = "nap:test-sweep"): PostgresAdvisoryLock {
  const sql = postgres(inject("postgresUrl"), { max: 1 });
  connections.push(sql);
  const lock = new PostgresAdvisoryLock(sql, name);
  locks.push(lock);
  return lock;
}

afterEach(async () => {
  for (const lock of locks.splice(0)) await lock.release();
  for (const sql of connections.splice(0)) await sql.end();
});

describe("PostgresAdvisoryLock", () => {
  it("gives the lock to exactly one of two processes started together", async () => {
    const first = reaper();
    const second = reaper();

    const answers = await Promise.all([first.held(), second.held()]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it("keeps saying yes to the holder without stacking the lock", async () => {
    // Every tick asks, so an implementation that took the lock again each time would hold it four
    // deep after four ticks and a single release would not let anybody else in.
    const holder = reaper();
    expect(await holder.held()).toBe(true);
    expect(await holder.held()).toBe(true);
    expect(await holder.held()).toBe(true);

    await holder.release();
    expect(await reaper().held()).toBe(true);
  });

  it("hands over when the holder leaves", async () => {
    const leaving = reaper();
    const arriving = reaper();
    expect(await leaving.held()).toBe(true);
    expect(await arriving.held()).toBe(false);

    await leaving.release();

    expect(await arriving.held()).toBe(true);
  });

  it("holds nothing after releasing, so a later tick takes it back", async () => {
    const lock = reaper();
    await lock.held();
    await lock.release();
    // Releasing is not retiring: the same process ticks again a minute later and should sweep.
    expect(await lock.held()).toBe(true);
  });

  it("does not contend with a lock under another name", async () => {
    const sweeper = reaper("nap:test-sweep-a");
    const other = reaper("nap:test-sweep-b");

    expect(await sweeper.held()).toBe(true);
    expect(await other.held()).toBe(true);
  });

  it("releasing what it never held is not an error", async () => {
    const holder = reaper();
    const loser = reaper();
    expect(await holder.held()).toBe(true);
    expect(await loser.held()).toBe(false);

    await expect(loser.release()).resolves.toBeUndefined();
    // And it took nothing away from the process that does hold it.
    expect(await holder.held()).toBe(true);
  });
});
