/**
 * The load harness's shared sandbox record, against a real Postgres.
 *
 * There is nothing to test here but the SQL: the behaviour that matters — reattaching instead of
 * cold-starting — lives in `sharedSandboxManager` and is covered by unit tests over a fake store.
 * What a fake cannot say is whether these statements run, whether the table this creates itself
 * survives two processes creating it at once, and whether a `jsonb` column comes back as the map
 * it went in as. All three are how a cluster run fails at minute two rather than at minute zero.
 */

import { createDatabase } from "@nap/db/client";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createSharedSandboxTable, PostgresSharedSandboxStore } from "./loadgen-sandbox-store.ts";

let db: PostgresJsDatabase;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = createDatabase(inject("postgresUrl")));
  await createSharedSandboxTable(db);
});

afterAll(async () => {
  await close();
});

/** Unique per test, because the suite shares one database with every other file in it. */
function ids() {
  return { sandboxId: crypto.randomUUID(), projectId: crypto.randomUUID() };
}

describe("PostgresSharedSandboxStore", () => {
  it("hands a sandbox another process recorded to the one that asks for it", async () => {
    const { sandboxId, projectId } = ids();
    await new PostgresSharedSandboxStore(db).record({ sandboxId, projectId, files: {} });

    // A second instance, because a second pod is the only situation this exists for.
    await expect(new PostgresSharedSandboxStore(db).find(sandboxId)).resolves.toEqual({
      sandboxId,
      projectId,
      files: {},
    });
  });

  it("returns the files as the map they were written as", async () => {
    const { sandboxId, projectId } = ids();
    const store = new PostgresSharedSandboxStore(db);
    await store.record({ sandboxId, projectId, files: {} });

    await store.saveFiles(sandboxId, { "/home/user/app/src/App.tsx": "export const App = 1;\n" });

    await expect(store.find(sandboxId)).resolves.toMatchObject({
      files: { "/home/user/app/src/App.tsx": "export const App = 1;\n" },
    });
  });

  it("knows nothing about a sandbox nobody recorded", async () => {
    await expect(new PostgresSharedSandboxStore(db).find(crypto.randomUUID())).resolves.toBeNull();
  });

  it("forgets a destroyed sandbox, so nothing reattaches to it", async () => {
    const { sandboxId, projectId } = ids();
    const store = new PostgresSharedSandboxStore(db);
    await store.record({ sandboxId, projectId, files: {} });

    await store.forget(sandboxId);

    await expect(store.find(sandboxId)).resolves.toBeNull();
  });

  it("saves nothing for an id it does not hold, rather than inventing a row", async () => {
    const sandboxId = crypto.randomUUID();
    const store = new PostgresSharedSandboxStore(db);

    await store.saveFiles(sandboxId, { "/a": "b" });

    await expect(store.find(sandboxId)).resolves.toBeNull();
  });

  it("survives every pod creating the table at once, which is how a cluster starts", async () => {
    await expect(
      Promise.all(Array.from({ length: 8 }, () => createSharedSandboxTable(db))),
    ).resolves.toBeDefined();
  });
});
