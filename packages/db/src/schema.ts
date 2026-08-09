/**
 * The Postgres schema, per docs/PLAN.md §5.
 *
 * `events` is the load-bearing table — chat transcript, agent audit log, WebSocket replay
 * source and v2's memory substrate, all one table — and its `unique(session_id, seq)` is
 * the database-level backstop for replay ordering. Application code is not trusted with
 * that invariant under concurrency; the index is.
 *
 * Two shapes here are deliberate and worth not "fixing" later:
 *
 *   - **`created_at` is `timestamptz`, but the event contract types `createdAt` as an ISO
 *     string.** The column stays a real timestamp because `readFrom` orders by it and by
 *     `seq`; the driver hands back a `Date`, so whatever reads events must map it with
 *     `.toISOString()`. `schema.db.test.ts` proves that mapping produces a valid `NapEvent`.
 *   - **`seq` is `integer`, not `bigint`.** `bigint` comes back from the driver as a string,
 *     which would quietly violate the `z.int()` in the contract. 2^31 events in one session
 *     is not a real ceiling.
 *
 * `events.turn_id` is not in §5's column list. §5 sketches the tables; the event union is
 * the precise contract, and it carries `turnId` in every envelope — so it gets a column
 * rather than being buried in `payload` where nothing could query it.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * What state a project is in, from the point of view of somebody looking at their list.
 *
 * Three of these are used and mean something exact: `creating` is a row that has never had a
 * sandbox, `ready` is one with a sandbox serving it now, and `idle` is one that has been put
 * away and will be restored from its snapshot on the next message. `archived` and `error` are
 * kept because removing a value from a Postgres enum costs a migration and neither is in the
 * way; nothing sets them, and anything that starts to should say what it means here first.
 */
export const projectStatus = pgEnum("project_status", [
  "creating",
  "ready",
  "idle",
  "archived",
  "error",
]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  createdAt,
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: projectStatus("status").notNull().default("creating"),
    /** Null until a sandbox has been created for this project. §5 marks both optional. */
    sandboxId: text("sandbox_id"),
    snapshotKey: text("snapshot_key"),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("projects_user_id_slug_unique").on(t.userId, t.slug)],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  createdAt,
});

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id").notNull(),
    seq: integer("seq").notNull(),
    /** Typed from the event union so the column and the contract cannot drift apart. */
    type: text("type").$type<NapEventType>().notNull(),
    payload: jsonb("payload").$type<NapEvent["payload"]>().notNull(),
    createdAt,
  },
  (t) => [unique("events_session_id_seq_unique").on(t.sessionId, t.seq)],
);

export const snapshots = pgTable("snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  r2Key: text("r2_key").notNull(),
  gitSha: text("git_sha").notNull(),
  createdAt,
});
