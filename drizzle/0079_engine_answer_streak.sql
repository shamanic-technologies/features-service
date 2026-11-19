-- DOC-DINNERS-SENDS-1119. A refusal streak survives the passes stated seconds before it by the SAME run (campaign-service
-- states "ran" at dispatch, the strategy answers the runner, then the gate refuses: prod 2026-11-19, a client out of
-- credit since 2026-11-10 read "on hold since today" on every tick). `streak_reason` = the reason of the current or last
-- refusal streak, `passing_since` = since when the Engine has been answered a pass with no refusal (null while held),
-- `expected` = the holder said the hold is a normal business state (the client's own credit or limit).
ALTER TABLE "campaign_engine_answers" ADD COLUMN IF NOT EXISTS "streak_reason" text;
--> statement-breakpoint
ALTER TABLE "campaign_engine_answers" ADD COLUMN IF NOT EXISTS "passing_since" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "campaign_engine_answers" ADD COLUMN IF NOT EXISTS "expected" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "campaign_engine_answers" SET "streak_reason" = "held_reason" WHERE "held_reason" IS NOT NULL AND "streak_reason" IS NULL;
