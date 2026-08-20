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
import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
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

/**
 * A person. Also the identity table the auth library reads and writes.
 *
 * The three columns below `name` exist for that library rather than for anything this
 * codebase asks of a user, which is why they are grouped and annotated: it maps its `user`
 * model onto this table instead of generating one of its own, so that `projects.user_id`
 * keeps pointing at the same uuid it always has.
 *
 * Every one of them has a default, so a row inserted by code that predates sign-in — the
 * placeholder in `session-bootstrap.ts` — is still valid.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  /** An avatar URL, when an OAuth provider supplies one. */
  image: text("image"),
  /**
   * Somebody who pressed "try it free" rather than signing up — a throwaway identity with a
   * real cookie, a real row and their own projects.
   *
   * The column is declared by the auth library's anonymous plugin rather than wanted by
   * anything here, which is why it sits with the three above it. What the app does with it is
   * decide how much of the deployment's money this person may spend; see the free tier in
   * `apps/api/src/turns/model-access.ts`.
   */
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Sign-in sessions — **not** the `sessions` table below, which is a conversation.
 *
 * The two words collide and only one of them can have the short name. `sessions` meant a chat
 * before authentication existed and is referenced by `events` and by every route in the app,
 * so the newcomer is the one that gets qualified. The auth library is told this name
 * explicitly; left to its own devices it would look for `sessions` and quietly start writing
 * login rows into the conversation table.
 */
export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** The value in the cookie. Unique because it is what a request is looked up by. */
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * How a person proves who they are: one row per credential, so a user can have several.
 *
 * An email/password signup stores its hash here in `password`; a GitHub sign-in stores the
 * provider's own user id in `account_id` and no password at all.
 *
 * **`unique(provider_id, account_id)` is a backstop, not the mechanism.** A repeat login finds
 * the same person because the auth library looks this row up before it inserts — deleting the
 * constraint changes nothing about an ordinary second sign-in, which is worth knowing before
 * anybody assumes the index is load-bearing. What it catches is the race the lookup cannot:
 * two callbacks for the same account arriving together, both finding nothing, both inserting.
 * `accounts.db.test.ts` is what proves it is really there, since no ordinary path reaches it.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The provider's identifier for this person — a GitHub user id, or the email for credentials. */
    accountId: text("account_id").notNull(),
    /** `github`, or `credential` for email and password. */
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** The password hash, for credential accounts. Never a plaintext password. */
    password: text("password"),
    createdAt,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("accounts_provider_id_account_id_unique").on(t.providerId, t.accountId)],
);

/**
 * Short-lived values the auth library needs to survive a redirect — chiefly the OAuth `state`
 * it hands to GitHub and checks on the way back. Rows here are expected to expire and be
 * cleaned up; nothing else in the app reads them.
 */
export const verifications = pgTable("verifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The API key somebody brought with them, so their turns are billed to their account and not
 * to this deployment's.
 *
 * **Never plaintext.** The bytes here are AES-256-GCM ciphertext sealed by
 * `apps/api/src/account/secret-box.ts`; this table has no way to read them and neither does a
 * query log, a backup, or anyone who gets a copy of the database without also having
 * `NAP_KEY_ENCRYPTION_SECRET`. `hint` is the only part meant to be shown — a masked tail, so
 * somebody can tell which of their keys this is without being shown the key.
 *
 * `user_id` is the primary key rather than a column beside one: a person has at most one key,
 * and expressing that in the schema means "replace my key" is an upsert instead of a delete
 * and an insert that could half-fail.
 */
export const userApiKeys = pgTable("user_api_keys", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Which vendor the key belongs to, and therefore which client a turn on it builds. */
  platform: text("platform").$type<"openrouter" | "anthropic">().notNull(),
  /** Base64 AES-256-GCM ciphertext with its auth tag appended. */
  ciphertext: text("ciphertext").notNull(),
  /** Base64, 12 random bytes, fresh for every write. Never reused across two seals. */
  iv: text("iv").notNull(),
  /** What is safe to show: `sk-or-…4f2a`. */
  hint: text("hint").notNull(),
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * One row per sandbox somebody is holding capacity for — the thing that bounds the bill.
 *
 * **The rows are the count.** `select count(*)` over this table, taken under an advisory lock in
 * the same transaction as the insert, is what makes admission atomic; `projects.sandbox_id` could
 * only ever be counted after the sandbox existed, which is one E2B call too late. See
 * `postgres-sandbox-capacity.ts` for the three transactions.
 *
 * `state` is `reserved` until the provider has answered and `active` afterwards. Both states
 * occupy capacity, which is the point: a creation in flight has already been paid for. It is text
 * rather than a pg enum because the reconciling sweep is expected to grow states, and adding a
 * value to an enum costs a migration.
 *
 * `expires_at` bounds only the `reserved` half — how long a process may hold capacity it has not
 * used, so that one dying between reserving and creating costs minutes rather than forever. An
 * activated row is set to `infinity`: it is released by the teardown that destroys its sandbox,
 * not by a clock.
 *
 * **Nothing sweeps expired rows yet.** What reads `expires_at` today is the reservation itself:
 * a project asking again for a slot it already holds gets that slot back once the row has expired,
 * so a crash mid-creation costs one project a couple of minutes rather than costing the ceiling a
 * slot forever. Reclaiming rows nobody asks about again is still to be built.
 */
export const sandboxReservations = pgTable(
  "sandbox_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: text("state").$type<"reserved" | "active">().notNull(),
    /** Null while `reserved`: there is nothing to name until the provider has answered. */
    sandboxId: text("sandbox_id"),
    createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // Partial, and load-bearing rather than a backstop: it is what stops two processes admitting
    // the same project twice and leaving it with a sandbox nothing references. Released rows are
    // deleted rather than marked, so no state outside these two needs excluding.
    uniqueIndex("sandbox_reservations_one_per_project")
      .on(t.projectId)
      .where(sql`${t.state} in ('reserved', 'active')`),
  ],
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
