ALTER TABLE "turn_requests" ADD COLUMN "target" jsonb;
--> statement-breakpoint
UPDATE "turn_requests" SET "target" = jsonb_build_object('kind', 'api', 'model', "model", 'billsToUser', "bills_to_user");
--> statement-breakpoint
ALTER TABLE "turn_requests" ALTER COLUMN "target" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "turn_requests" DROP COLUMN "model";--> statement-breakpoint
ALTER TABLE "turn_requests" DROP COLUMN "bills_to_user";