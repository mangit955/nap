/**
 * Where the load harness's fake sandboxes are written down, so every pod can find them.
 *
 * `sharedSandboxManager` states the problem in full: an in-memory sandbox belongs to the process
 * that created it, so a worker pod claiming a project's next turn cold-starts a new one and the
 * ramp measures the fake rather than the deployment. This is the backing it needs — Postgres,
 * because every load composition already has one open, and because a fix that needed a vendor
 * would cost money and defeat the point of a free ramp.
 *
 * **The table is created here rather than by a migration.** It belongs to the harness and not to
 * the product: nothing that ships reads it, and a migration would put a load test's table into
 * every real deployment. `createSharedSandboxTable` is idempotent and safe to call from every pod
 * at once, which is how a cluster starts.
 */

import type { SharedSandboxRecord, SharedSandboxStore } from "@nap/loadgen/shared-sandbox-manager";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

/**
 * An arbitrary constant, and the only thing that stops two pods creating the table at the same
 * instant: `create table if not exists` is not internally serialized, and two of them racing
 * raises a duplicate-key error on `pg_type` rather than quietly doing nothing.
 */
const CREATE_LOCK = 0x10adbe17;

const row = z.object({
  project_id: z.string(),
  // `jsonb`, so postgres.js hands back the parsed object rather than the text of it.
  files: z.record(z.string(), z.string()),
});

export async function createSharedSandboxTable(db: PostgresJsDatabase): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_LOCK})`);
    await tx.execute(sql`
      create table if not exists loadgen_sandboxes (
        sandbox_id text primary key,
        project_id text not null,
        files jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);
  });
}

export class PostgresSharedSandboxStore implements SharedSandboxStore {
  readonly #db: PostgresJsDatabase;

  constructor(db: PostgresJsDatabase) {
    this.#db = db;
  }

  async record(record: SharedSandboxRecord): Promise<void> {
    await this.#db.execute(sql`
      insert into loadgen_sandboxes (sandbox_id, project_id, files)
      values (${record.sandboxId}, ${record.projectId}, ${JSON.stringify(record.files)}::jsonb)
      on conflict (sandbox_id) do update
        set project_id = excluded.project_id, files = excluded.files
    `);
  }

  async find(sandboxId: string): Promise<SharedSandboxRecord | null> {
    const [found] = await this.#db.execute(sql`
      select project_id, files from loadgen_sandboxes where sandbox_id = ${sandboxId}
    `);
    if (found === undefined) return null;

    const parsed = row.parse(found);
    return { sandboxId, projectId: parsed.project_id, files: parsed.files };
  }

  async saveFiles(sandboxId: string, files: Record<string, string>): Promise<void> {
    // No upsert: a row that is not here was destroyed, and re-creating it from a write would
    // resurrect a sandbox the fake has already forgotten.
    await this.#db.execute(sql`
      update loadgen_sandboxes set files = ${JSON.stringify(files)}::jsonb
      where sandbox_id = ${sandboxId}
    `);
  }

  async forget(sandboxId: string): Promise<void> {
    await this.#db.execute(sql`delete from loadgen_sandboxes where sandbox_id = ${sandboxId}`);
  }
}
