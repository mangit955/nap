ALTER TABLE "provider_sign_in_attempts" ADD COLUMN "state_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_sign_in_attempts" ADD CONSTRAINT "provider_sign_in_state_version_nonnegative" CHECK ("state_version" >= 0);
