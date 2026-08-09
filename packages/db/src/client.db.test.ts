import { sql } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";
import { createDatabase } from "./client.ts";
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
