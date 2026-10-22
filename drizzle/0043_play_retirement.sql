-- PLAY-RETIRE-1022 (owner 2026-10-22): staff take a non-default play off a pipe when its strategy belongs on another
-- pipe. The row is kept (who ran it stays readable) and every campaign whose funnel names it runs the pipe's DEFAULT
-- play from then on. Re-cataloguing the play (POST plays) revives it.
ALTER TABLE "plays" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "plays" ADD COLUMN IF NOT EXISTS "retired_by" text;
--> statement-breakpoint
ALTER TABLE "plays" ADD COLUMN IF NOT EXISTS "retired_note" text;
