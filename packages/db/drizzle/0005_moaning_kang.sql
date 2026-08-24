CREATE TYPE "public"."turn_request_kind" AS ENUM('turn', 'resume');--> statement-breakpoint
CREATE TYPE "public"."turn_request_state" AS ENUM('queued', 'leased', 'done', 'failed', 'orphaned');--> statement-breakpoint
CREATE TABLE "turn_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "turn_request_kind" NOT NULL,
	"state" "turn_request_state" DEFAULT 'queued' NOT NULL,
	"message" text,
	"model" text NOT NULL,
	"bills_to_user" boolean DEFAULT false NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "turn_requests" ADD CONSTRAINT "turn_requests_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_requests" ADD CONSTRAINT "turn_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_requests_one_leased_per_session" ON "turn_requests" USING btree ("session_id") WHERE "turn_requests"."state" = 'leased';--> statement-breakpoint
CREATE INDEX "turn_requests_queued" ON "turn_requests" USING btree ("created_at") WHERE "turn_requests"."state" = 'queued';--> statement-breakpoint
CREATE INDEX "turn_requests_lease_expiry" ON "turn_requests" USING btree ("lease_expires_at") WHERE "turn_requests"."state" = 'leased';