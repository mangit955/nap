-- Where a project's name came from (docs/adr/0031).
--
-- Every existing row is marked 'user': nothing can tell which of them somebody named by hand, and
-- a name nobody will overwrite is the safe answer. New rows default to 'seed'. Both happen in the
-- one ADD COLUMN, whose default fills existing rows, before the default is changed.
ALTER TABLE "projects" ADD COLUMN "name_source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "name_source" SET DEFAULT 'seed';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "title_generation" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "title_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "title_auto_attempted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_source" CHECK ("projects"."name_source" in ('seed', 'model', 'user'));
