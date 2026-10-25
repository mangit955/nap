CREATE TABLE "project_computer_operations" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "sandbox_id" text NOT NULL,
  "scope_id" uuid NOT NULL,
  "actor" jsonb NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "next_recovery_at" timestamp with time zone DEFAULT now() + interval '15 seconds' NOT NULL,
  CONSTRAINT "project_computer_operations_state" CHECK ("state" IN ('active', 'recovering')),
  CONSTRAINT "project_computer_operations_scope_id_unique" UNIQUE ("scope_id"),
  CONSTRAINT "project_computer_operations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE,
  CONSTRAINT "project_computer_operations_actor" CHECK ((jsonb_typeof("actor") = 'object' and (("actor"->>'kind' = 'owner' and jsonb_typeof("actor"->'binding') = 'object' and "actor" - 'kind' - 'binding' = '{}'::jsonb and "actor"->'binding'->>'userId' is not null and "actor"->'binding'->>'sessionId' is not null and "actor"->'binding'->>'revision' is not null and "actor"->'binding'->>'expiresAt' is not null and "actor"->'binding'->>'projectId' = "project_id"::text and "actor"->'binding'->>'sandboxId' = "sandbox_id") or ("actor"->>'kind' = 'turn' and jsonb_typeof("actor"->'lease') = 'object' and "actor" - 'kind' - 'lease' = '{}'::jsonb and "actor"->'lease'->>'requestId' is not null and "actor"->'lease'->>'owner' is not null))) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX "project_computer_operations_recovery" ON "project_computer_operations" ("next_recovery_at");
