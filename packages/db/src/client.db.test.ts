import { sql } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";
import { createDatabase, pingDatabase } from "./client.ts";
import { PostgresEventStore } from "./postgres-event-store.ts";

describe("createDatabase", () => {
  it("opens a pool that can run a query", async () => {
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    try {
      const rows = await db.execute(sql`select 1 as one`);
      expect([...rows][0]).toEqual({ one: 1 });
    } finally {
      await close();
    }
  });

  it("closes, so a process using it can exit", async () => {
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    await close();

    // An idle connection left open is a process that never exits; the driver refusing work
    // after `close` is what proves the pool actually went away.
    await expect(db.execute(sql`select 1`)).rejects.toThrow();
  });

  it("produces a database an EventStore can be built on", async () => {
    // The one thing boot does with it, so the wiring is not first exercised in production.
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    try {
      const store = new PostgresEventStore(db);
      expect(await store.readFrom("0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f", 0)).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe("pingDatabase", () => {
  it("resolves against a database that is there", async () => {
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    try {
      await expect(pingDatabase(db)).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it("rejects when the database cannot be reached", async () => {
    // The whole contract. A probe that resolved on failure would report every outage as
    // healthy, which is strictly worse than having no health check at all — and nothing above
    // it could tell, because "reachable" is the only thing it ever says.
    const { db, close } = createDatabase("postgres://nobody@127.0.0.1:1/nothing", { max: 1 });
    try {
      await expect(pingDatabase(db)).rejects.toThrow();
    } finally {
      await close().catch(() => {});
    }
  });

  it("rejects once the pool it was given has been closed", async () => {
    // How a real outage arrives at this function: the pool, not the query, is what breaks.
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    await close();

    await expect(pingDatabase(db)).rejects.toThrow();
  });

  it("asks nothing of the schema, so a migration gap is not reported as an outage", async () => {
    // `select 1` touches no table on purpose. A probe that queried a real one would go down
    // on a missing migration, which is a different problem for a different person.
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    try {
      await db.execute(sql`set search_path to pg_catalog`);
      await expect(pingDatabase(db)).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });
});
