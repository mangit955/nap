CREATE TABLE "turn_rate_events" (
	"user_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turn_rate_events" ADD CONSTRAINT "turn_rate_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "turn_rate_events_user_tier_at" ON "turn_rate_events" USING btree ("user_id","tier","at");