CREATE TABLE "native_deliveries" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"raw_hash" text NOT NULL,
	"raw" jsonb NOT NULL,
	"event_hash" text NOT NULL,
	"event_sequences" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_deliveries_run_id_sequence_pk" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "native_deliveries_sequence" CHECK ("native_deliveries"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "native_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"worker_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"binding" jsonb NOT NULL,
	"phase" text NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"delivery_bytes" integer DEFAULT 0 NOT NULL,
	"native_session_id" text,
	"receipt" jsonb,
	"proof" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_runs_one_intent_per_turn" UNIQUE("turn_id"),
	CONSTRAINT "native_runs_cursor" CHECK ("native_runs"."cursor" >= 0),
	CONSTRAINT "native_runs_delivery_bytes" CHECK ("native_runs"."delivery_bytes" >= 0 and "native_runs"."delivery_bytes" <= 67108864),
	CONSTRAINT "native_runs_phase" CHECK ("native_runs"."phase" in ('intent', 'start_uncertain', 'started', 'stopped')),
	CONSTRAINT "native_runs_state" CHECK (("native_runs"."phase" in ('intent', 'start_uncertain') and "native_runs"."receipt" is null and "native_runs"."native_session_id" is null and "native_runs"."proof" is null) or ("native_runs"."phase" = 'started' and "native_runs"."receipt" is not null and "native_runs"."native_session_id" is not null and "native_runs"."proof" is null) or ("native_runs"."phase" = 'stopped' and "native_runs"."proof" is not null))
);
--> statement-breakpoint
ALTER TABLE "native_deliveries" ADD CONSTRAINT "native_deliveries_run_id_native_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."native_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_runs_one_active_project" ON "native_runs" USING btree ("project_id") WHERE "native_runs"."phase" <> 'stopped';--> statement-breakpoint
CREATE UNIQUE INDEX "native_runs_one_active_account" ON "native_runs" USING btree ("account_id") WHERE "native_runs"."phase" <> 'stopped';