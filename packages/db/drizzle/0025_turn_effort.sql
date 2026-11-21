-- How hard each queued turn thinks, chosen per turn beside its model. Nullable: rows queued before
-- this run at the deployment's configured effort.
--
-- The checks are NOT VALID: every existing row is null, so there is nothing to check, and
-- validating would scan the whole queue under the lock this ALTER holds while the previous release
-- is still serving. New and updated rows are checked all the same.
ALTER TABLE "turn_requests" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "turn_steers" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "turn_requests" ADD CONSTRAINT "turn_requests_effort" CHECK ("turn_requests"."effort" is null or "turn_requests"."effort" in ('low', 'medium', 'high', 'xhigh', 'max')) NOT VALID;--> statement-breakpoint
ALTER TABLE "turn_steers" ADD CONSTRAINT "turn_steers_effort" CHECK ("turn_steers"."effort" is null or "turn_steers"."effort" in ('low', 'medium', 'high', 'xhigh', 'max')) NOT VALID;