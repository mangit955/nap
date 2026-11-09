-- The session sidebar's card, search and auto-settle.
--
-- The two indexes on "events" are built in this migration's transaction, so appends wait while
-- they are built: each reads the whole table once. Both are partial and small (a few rows per
-- turn), and Postgres has no CONCURRENTLY inside a transaction, which is how drizzle migrates.
--
-- pg_trgm is a trusted extension (Postgres 13+), so the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "navigation_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"auto_settle_after_days" integer,
	"auto_settle_on_merge" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_settle_floor" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "navigation_settings" ADD CONSTRAINT "navigation_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_session_terminal" ON "events" USING btree ("session_id","created_at","seq") WHERE "events"."type" in ('turn.completed', 'turn.failed', 'job.completed');--> statement-breakpoint
CREATE INDEX "events_message_text_trgm" ON "events" USING gin (("payload" ->> 'text') gin_trgm_ops) WHERE "events"."type" in ('user.message', 'steer.received');