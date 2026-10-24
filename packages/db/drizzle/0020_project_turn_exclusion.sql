ALTER TABLE "turn_requests" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "turn_requests" q SET "project_id" = s."project_id" FROM "sessions" s WHERE s."id" = q."session_id";--> statement-breakpoint
CREATE FUNCTION "derive_turn_request_project"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE derived_project uuid;
BEGIN
  SELECT project_id INTO derived_project FROM sessions WHERE id = NEW.session_id;
  IF derived_project IS NULL THEN
    RAISE EXCEPTION 'turn request session is missing' USING ERRCODE = '23503';
  END IF;
  IF NEW.project_id IS NOT NULL AND NEW.project_id <> derived_project THEN
    RAISE EXCEPTION 'turn request project does not match its session' USING ERRCODE = '23514';
  END IF;
  NEW.project_id := derived_project;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "turn_requests_derive_project" BEFORE INSERT OR UPDATE OF session_id, project_id ON "turn_requests" FOR EACH ROW EXECUTE FUNCTION "derive_turn_request_project"();--> statement-breakpoint
ALTER TABLE "turn_requests" ADD CONSTRAINT "turn_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turn_requests_one_leased_per_project" ON "turn_requests" USING btree ("project_id") WHERE "turn_requests"."state" = 'leased';--> statement-breakpoint
ALTER TABLE "turn_requests" ADD CONSTRAINT "turn_requests_project_required" CHECK ("turn_requests"."project_id" is not null);
