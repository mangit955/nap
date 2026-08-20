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
import { TURN_REQUEST_KINDS, TURN_REQUEST_STATES } from "@nap/shared/ports/turn-queue";
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
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
 * **Two things read `expires_at`.** The reservation itself: a project asking again for a slot it
 * already holds gets that slot back once the row has expired, so a crash mid-creation costs one
 * project a couple of minutes rather than costing the ceiling a slot forever. And the reaper's
 * reconciling pass — `postgres-capacity-reconciler.ts` — which deletes expired rows nobody ever
 * asks about again, and `active` rows whose sandbox no project names any more.
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

/**
 * One row per turn somebody was *allowed* to start — the sliding window, kept where every replica
 * can see it.
 *
 * **Accepted turns only.** A refused attempt writes nothing, or a client retrying in a loop would
 * push its own recovery further away with every attempt and the wait it was told would never
 * arrive. That single rule is why the count here is exactly what the window holds, and why the
 * oldest row inside it is precisely when a slot opens.
 *
 * `tier` is what keeps two allowances two allowances: turns this deployment pays for are limited
 * because that is the only reason the door can be open to strangers, and turns somebody pays for
 * themselves are limited to stop a runaway loop. Sharing one count would let the second eat the
 * first.
 *
 * There is no `id`: nothing ever addresses one of these rows. They are counted inside the window
 * and deleted in bulk once past it, so a key would be bytes and an index nobody reads.
 */
export const turnRateEvents = pgTable(
  "turn_rate_events",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tier: text("tier").$type<"free" | "paid">().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The exact shape of both statements that touch this table: admission counts one user's rows
    // in one tier since a cutoff, and the sweep deletes across users by the same cutoff. Without
    // it, every turn in the cluster is a sequential scan over every turn recently taken.
    index("turn_rate_events_user_tier_at").on(t.userId, t.tier, t.at),
  ],
);

/**
 * What state a queued execution intent is in. The transitions are in `docs/scaling-design.md` §18.
 *
 * **There is no edge back to `queued`.** A request is claimed at most once, so a worker that dies
 * mid-turn leaves a partial event log rather than a turn that runs twice — and a partial log is
 * something `foldJobs` already reads, where a duplicated turn is not. `orphaned` is the janitor's:
 * the lease ran out and the request was closed for it, never re-claimed.
 *
 * **Both enums are declared from the port's own tuples**, so the column and the type a caller
 * writes against cannot drift into disagreeing. This is the one place a `pgEnum` is worth having
 * over `text` — unlike `sandbox_reservations.state`, this is a closed state machine a design
 * document draws, where that one is expected to grow states as the reconciling sweep learns to
 * find more.
 */
export const turnRequestState = pgEnum("turn_request_state", TURN_REQUEST_STATES);

/** What the request asks for: a turn on a prompt, or bringing a put-away project back up. */
export const turnRequestKind = pgEnum("turn_request_kind", TURN_REQUEST_KINDS);

/**
 * The queue of turn requests, and the leases that make one per session exclusive.
 *
 * This table is the distributed `SessionQueue`. The old one was a `Map` of promises in a single
 * process: it stopped a turn and a project-open both creating a sandbox for the same project, and
 * stopped nothing once a second process existed. Here the rule is a **partial unique index** over
 * `state = 'leased'`, the same posture `unique(session_id, seq)` takes with replay ordering —
 * application code is not trusted with an invariant it cannot see the other side of.
 *
 * `lease_owner` names the *worker process*, and every renewal and settlement is conditional on it.
 * That is the fencing: a worker can outlive its lease through a GC pause or a network blip, and
 * without the predicate it would keep writing to a session another worker had already claimed.
 * A settled row keeps its `lease_owner` — who ran a request is worth being able to read
 * afterwards, and only `state` decides whether the index applies — but its `lease_expires_at` is
 * cleared, because nothing is waiting on that row any more and a stale deadline on it would read
 * as a lease the janitor should be interested in.
 * */
export const turnRequests = pgTable(
  "turn_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: turnRequestKind("kind").notNull(),
    state: turnRequestState("state").notNull().default("queued"),
    /** The prompt. Null for `resume`, which asks for no new work. */
    message: text("message"),
    /** Resolved at admission: which models somebody may name is a fact about who is asking. */
    model: text("model").notNull(),
    /**
     * Whether the asker's own account pays.
     *
     * **Never a key.** The worker re-opens the caller's stored credential by `user_id`, so
     * plaintext credentials never touch this table, a query log, or a backup.
     */
    billsToUser: boolean("bills_to_user").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    /** Which worker process holds the lease. Every renewal is conditional on it. */
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt,
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // The mechanism, not a backstop. Two workers claiming one session is the failure that leaves a
    // project holding two sandboxes, and it is unreachable only because this index exists.
    uniqueIndex("turn_requests_one_leased_per_session")
      .on(t.sessionId)
      .where(sql`${t.state} = 'leased'`),
    // The claim's exact shape: oldest queued row first. Partial, so the index stays the size of
    // the backlog rather than of every turn this deployment has ever run.
    index("turn_requests_queued").on(t.createdAt).where(sql`${t.state} = 'queued'`),
    // The janitor's: which leases have run out. Partial for the same reason.
    index("turn_requests_lease_expiry").on(t.leaseExpiresAt).where(sql`${t.state} = 'leased'`),
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
