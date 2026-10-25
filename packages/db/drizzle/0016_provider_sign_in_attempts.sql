CREATE TYPE "public"."provider_sign_in_phase" AS ENUM('starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "provider_sign_in_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"auth_session_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"phase" "provider_sign_in_phase" NOT NULL,
	"challenge_hash" text,
	"claim_token_hash" text,
	"state_ciphertext" text,
	"state_iv" text,
	"interaction" jsonb,
	"message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_sign_ins_generation" CHECK ("provider_sign_in_attempts"."generation" >= 0),
	CONSTRAINT "provider_sign_ins_expiry" CHECK ("provider_sign_in_attempts"."expires_at" > "provider_sign_in_attempts"."created_at"),
	CONSTRAINT "provider_sign_ins_state" CHECK ((
    "provider_sign_in_attempts"."phase" in ('starting', 'waiting', 'verifying') and "provider_sign_in_attempts"."state_ciphertext" is not null and length("provider_sign_in_attempts"."state_ciphertext") > 0 and "provider_sign_in_attempts"."state_iv" is not null and length("provider_sign_in_attempts"."state_iv") > 0 and "provider_sign_in_attempts"."challenge_hash" is not null and "provider_sign_in_attempts"."challenge_hash" ~ '^[a-f0-9]{64}$'
  ) or (
    "provider_sign_in_attempts"."phase" in ('succeeded', 'failed', 'cancelled') and "provider_sign_in_attempts"."state_ciphertext" is null and "provider_sign_in_attempts"."state_iv" is null and "provider_sign_in_attempts"."challenge_hash" is null
  )),
	CONSTRAINT "provider_sign_ins_claim" CHECK (("provider_sign_in_attempts"."phase" = 'verifying' and "provider_sign_in_attempts"."claim_token_hash" is not null and "provider_sign_in_attempts"."claim_token_hash" ~ '^[a-f0-9]{64}$') or ("provider_sign_in_attempts"."phase" <> 'verifying' and "provider_sign_in_attempts"."claim_token_hash" is null)),
	CONSTRAINT "provider_sign_ins_interaction" CHECK (("provider_sign_in_attempts"."phase" = 'waiting') = ("provider_sign_in_attempts"."interaction" is not null)),
	CONSTRAINT "provider_sign_ins_message" CHECK (("provider_sign_in_attempts"."phase" = 'failed' and "provider_sign_in_attempts"."message" is not null and length("provider_sign_in_attempts"."message") > 0) or ("provider_sign_in_attempts"."phase" <> 'failed' and "provider_sign_in_attempts"."message" is null))
);
--> statement-breakpoint
ALTER TABLE "provider_sign_in_attempts" ADD CONSTRAINT "provider_sign_in_attempts_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_sign_in_attempts" ADD CONSTRAINT "provider_sign_in_attempts_auth_session_id_auth_sessions_id_fk" FOREIGN KEY ("auth_session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_sign_ins_session_created" ON "provider_sign_in_attempts" USING btree ("account_id","auth_session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_sign_ins_one_active" ON "provider_sign_in_attempts" USING btree ("account_id") WHERE "provider_sign_in_attempts"."phase" in ('starting', 'waiting', 'verifying');