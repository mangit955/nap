import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql as sqlOf } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { expect, inject, it } from "vitest";
import { z } from "zod";
import { PostgresTurnQueue } from "./postgres-turn-queue.ts";
import { projects, sessions, users } from "./schema.ts";
import { MIGRATIONS_FOLDER } from "./testing/postgres-container.ts";

const Journal = z.object({
  version: z.string(),
  dialect: z.string(),
  entries: z.array(
    z.object({
      idx: z.int(),
      version: z.string(),
      when: z.int(),
      tag: z.string(),
      breakpoints: z.boolean(),
    }),
  ),
});

it("backfills existing queue projects before enforcing project exclusion on upgrade", async () => {
  const folder = await mkdtemp(join(tmpdir(), "nap-queue-upgrade-"));
  const name = `queue_upgrade_${randomUUID().replaceAll("-", "")}`;
  const admin = postgres(inject("postgresUrl"), { max: 1 });
  const address = new URL(inject("postgresUrl"));
  address.pathname = `/${name}`;
  let client: postgres.Sql | undefined;
  let created = false;
  try {
    const journal = Journal.parse(
      JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")),
    );
    const previous = { ...journal, entries: journal.entries.filter((entry) => entry.idx < 20) };
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify(previous));
    for (const entry of previous.entries)
      await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    await drizzle(admin).execute(sqlOf`create database ${sqlOf.identifier(name)}`);
    created = true;
    client = postgres(address.toString(), { max: 1 });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: folder });
    const [user] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: "Upgrade" })
      .returning();
    if (!user) throw new Error("Missing upgrade user");
    const [project] = await db
      .insert(projects)
      .values({ userId: user.id, name: "Existing project", slug: randomUUID() })
      .returning();
    if (!project) throw new Error("Missing upgrade project");
    const [session] = await db
      .insert(sessions)
      .values({ projectId: project.id, title: "Existing session" })
      .returning();
    if (!session) throw new Error("Missing upgrade session");
    const requestId = randomUUID();
    await db.execute(
      sqlOf`insert into turn_requests (id, session_id, user_id, kind, message, target) values (${requestId}::uuid, ${session.id}::uuid, ${user.id}::uuid, 'turn', 'Existing work', '{"kind":"api","model":"fixture","billsToUser":false}'::jsonb)`,
    );
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const rows = await db.execute(
      sqlOf`select project_id from turn_requests where id = ${requestId}::uuid`,
    );
    expect(rows[0]?.project_id).toBe(project.id);
    expect((await new PostgresTurnQueue(db).claim("upgraded-worker"))?.id).toBe(requestId);
    const [sibling] = await db
      .insert(sessions)
      .values({ projectId: project.id, title: "Sibling" })
      .returning();
    if (!sibling) throw new Error("Missing upgrade sibling");
    const queue = new PostgresTurnQueue(db);
    await queue.enqueue({
      id: randomUUID(),
      userId: user.id,
      sessionId: sibling.id,
      kind: "turn",
      message: "Wait",
      target: { kind: "api", model: "fixture", billsToUser: false },
    });
    expect(await queue.claim("sibling-worker")).toBeNull();
  } finally {
    await client?.end();
    if (created) await drizzle(admin).execute(sqlOf`drop database ${sqlOf.identifier(name)}`);
    await admin.end();
    await rm(folder, { recursive: true, force: true });
  }
});
