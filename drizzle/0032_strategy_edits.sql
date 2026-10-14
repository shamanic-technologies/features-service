-- STRATEGY-EDIT-PUBLIC-1014 (2026-10-14): a strategy's requires / excludes / description can be EDITED (staff), so a
-- new tactic never leaks into an older strategy that names nothing about it. Who last edited it, and when.
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "updated_by" text;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
