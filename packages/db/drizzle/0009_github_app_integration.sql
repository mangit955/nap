ALTER TYPE "public"."turn_request_kind" ADD VALUE 'publish';--> statement-breakpoint
CREATE TABLE "github_connection_states" (
	"hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"installation_id" bigint,
	"stage" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_repositories" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository" jsonb NOT NULL,
	"base_branch" text NOT NULL,
	"environment" jsonb NOT NULL,
	"auto_publish" boolean NOT NULL,
	CONSTRAINT "project_repositories_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "repository_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repository_jobs" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"base_branch" text NOT NULL,
	"head_branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_sha" text,
	"pushed_sha" text,
	"pull_request_number" integer,
	"pull_request_url" text,
	"pull_request_state" text NOT NULL,
	"publish_state" text NOT NULL,
	"check_state" text NOT NULL,
	"review_state" text NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_connection_states" ADD CONSTRAINT "github_connection_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_repositories" ADD CONSTRAINT "project_repositories_installation_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("installation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_feedback" ADD CONSTRAINT "repository_feedback_job_id_repository_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."repository_jobs"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_feedback" ADD CONSTRAINT "repository_feedback_request_id_turn_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."turn_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_feedback" ADD CONSTRAINT "repository_feedback_project_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project_repositories"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_jobs" ADD CONSTRAINT "repository_jobs_project_id_project_repositories_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project_repositories"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_jobs" ADD CONSTRAINT "repository_jobs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_deliveries_pending" ON "github_deliveries" USING btree ("next_attempt_at") WHERE "github_deliveries"."state" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "github_installations_owner" ON "github_installations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "project_repositories_installation" ON "project_repositories" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "repository_feedback_project" ON "repository_feedback" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "repository_jobs_project_branch" ON "repository_jobs" USING btree ("project_id","head_branch");--> statement-breakpoint
CREATE INDEX "repository_jobs_open_pr" ON "repository_jobs" USING btree ("updated_at") WHERE "repository_jobs"."pull_request_state" = 'open';