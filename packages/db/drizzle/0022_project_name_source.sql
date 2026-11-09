-- Where a project's name came from (docs/adr/0031).
--
-- Every existing row is marked 'user': nothing can tell which of them somebody named by hand, and
-- a name nobody will overwrite is the safe answer. New rows default to 'seed'. Both happen in the
-- one ADD COLUMN, whose default fills existing rows, before the default is changed.
--
-- The exception is a project still called the placeholder (`isUnnamed` in
-- packages/shared/src/project-title.ts): nobody chose that, and before this column its first prompt
-- would have named it. Marked 'seed', it still will.
ALTER TABLE "projects" ADD COLUMN "name_source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "name_source" SET DEFAULT 'seed';--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "title_generation" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "title_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "title_auto_attempted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_name_source" CHECK ("projects"."name_source" in ('seed', 'model', 'user'));--> statement-breakpoint
UPDATE "projects" SET "name_source" = 'seed' WHERE lower(btrim("name")) in ('untitled project', '');
