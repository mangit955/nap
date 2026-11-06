ALTER TABLE "sessions" ADD COLUMN "head_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Every existing session's counter starts where its log ends. The append would catch up from
-- max(seq) on its own, so this is not what keeps a session writable — it is what keeps the
-- counter meaning what it says from the moment the column exists.
UPDATE "sessions" SET "head_seq" = "heads"."seq"
FROM (SELECT "session_id", max("seq") AS "seq" FROM "events" GROUP BY "session_id") AS "heads"
WHERE "sessions"."id" = "heads"."session_id";
