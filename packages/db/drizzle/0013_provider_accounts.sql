CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"driver" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_status" text DEFAULT 'unauthenticated' NOT NULL,
	"account_email" text,
	"account_plan" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_accounts_user_created" ON "provider_accounts" USING btree ("user_id","created_at");