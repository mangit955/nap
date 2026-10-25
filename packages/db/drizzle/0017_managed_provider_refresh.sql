CREATE TABLE "provider_credential_refreshes" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"claim_token_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_refresh_phase" CHECK ("provider_credential_refreshes"."phase" in ('claimed', 'uncertain')),
	CONSTRAINT "provider_refresh_claim" CHECK ((
    "provider_credential_refreshes"."phase" = 'claimed' and "provider_credential_refreshes"."claim_token_hash" is not null and "provider_credential_refreshes"."claim_token_hash" ~ '^[a-f0-9]{64}$' and "provider_credential_refreshes"."expires_at" is not null and "provider_credential_refreshes"."expires_at" > "provider_credential_refreshes"."created_at"
  ) or (
    "provider_credential_refreshes"."phase" = 'uncertain' and "provider_credential_refreshes"."claim_token_hash" is null and "provider_credential_refreshes"."expires_at" is null
  ))
);
--> statement-breakpoint
ALTER TABLE "provider_credential_refreshes" ADD CONSTRAINT "provider_refresh_account_fk" FOREIGN KEY ("account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;