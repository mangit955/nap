CREATE TYPE "public"."steer_state" AS ENUM('pending', 'applied', 'deferred', 'dropped');--> statement-breakpoint
CREATE TABLE "turn_steers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"message" text NOT NULL,
	"plan" jsonb,
	"model" text NOT NULL,
	"bills_to_user" boolean DEFAULT false NOT NULL,
	"state" "steer_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "turn_requests" ADD COLUMN "steering_closed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "turn_steers" ADD CONSTRAINT "turn_steers_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_steers" ADD CONSTRAINT "turn_steers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_steers" ADD CONSTRAINT "turn_steers_request_id_turn_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."turn_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_steers_waiting" ON "turn_steers" USING btree ("request_id","created_at") WHERE "turn_steers"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "turn_steers_request" ON "turn_steers" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "turn_steers_session" ON "turn_steers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "turn_steers_user" ON "turn_steers" USING btree ("user_id");