CREATE TABLE "provider_credentials" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"ciphertext" text,
	"iv" text,
	CONSTRAINT "provider_credentials_revision" CHECK ("provider_credentials"."generation" >= 0 and "provider_credentials"."version" >= 0),
	CONSTRAINT "provider_credentials_pair" CHECK (("provider_credentials"."ciphertext" is null and "provider_credentials"."iv" is null) or ("provider_credentials"."ciphertext" is not null and "provider_credentials"."iv" is not null and length("provider_credentials"."ciphertext") > 0 and length("provider_credentials"."iv") > 0))
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;