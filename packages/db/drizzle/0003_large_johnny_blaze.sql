CREATE TABLE "sandbox_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text NOT NULL,
	"sandbox_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sandbox_reservations" ADD CONSTRAINT "sandbox_reservations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_reservations" ADD CONSTRAINT "sandbox_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_reservations_one_per_project" ON "sandbox_reservations" USING btree ("project_id") WHERE "sandbox_reservations"."state" in ('reserved', 'active');--> statement-breakpoint
-- Hand-written, and not something `drizzle-kit generate` would produce: every sandbox already
-- running when this migration lands has no reservation and would therefore be counted by nothing.
-- The ceiling this table exists to enforce would start out believing the deployment was empty and
-- admit a second full set of sandboxes on top of the ones it is already paying for.
INSERT INTO "sandbox_reservations" ("project_id", "user_id", "state", "sandbox_id", "expires_at")
SELECT "id", "user_id", 'active', "sandbox_id", 'infinity' FROM "projects" WHERE "sandbox_id" IS NOT NULL;