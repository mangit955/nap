-- The session sidebar's card, search and auto-settle.
--
-- drizzle runs every pending migration in one transaction, and Postgres has no CONCURRENTLY
-- inside one, so the two indexes on "events" are built while that table refuses writes: event
-- appends wait until the transaction commits. Each reads the whole table once; both are partial
-- and small, a few rows per turn. The ALTER TABLEs, whose locks block reads as well and are held
-- until commit, come after the scans, so "projects" and "repository_jobs" are locked only for the
-- migration's last moments, and "users" (for the foreign key) only as briefly.
--
-- There is deliberately no index on "sessions" here. An append updates "sessions" and then
-- inserts into "events", so a "sessions" index built after the "events" scans deadlocks with any
-- append caught waiting on "events"; that index belongs in a later release's own migration.
-- One cycle remains: deleting a session during the scans holds "projects" while its cascade waits
-- on "events", and the ALTER on "projects" then deadlocks with it. Whichever Postgres aborts rolls
-- back whole, so a failed migration is safe to run again.
--
-- pg_trgm is a trusted extension (Postgres 13+), so the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "events_session_terminal" ON "events" USING btree ("session_id","created_at","seq") WHERE "events"."type" in ('turn.completed', 'turn.failed', 'job.completed');--> statement-breakpoint
CREATE INDEX "events_message_text_trgm" ON "events" USING gin (("payload" ->> 'text') gin_trgm_ops) WHERE "events"."type" in ('user.message', 'steer.received');--> statement-breakpoint
CREATE TABLE "navigation_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"auto_settle_after_days" integer,
	"auto_settle_on_merge" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "navigation_settings" ADD CONSTRAINT "navigation_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_jobs" ADD COLUMN "pull_request_merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_settle_floor" timestamp with time zone;
