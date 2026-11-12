-- LLM-RATING-PER-ENGINE-1112 (OFFER-FIELDS-NO-OPUS-1112): a call is placed by the pick its PARENT run asked for (a service
-- with no script, e.g. brand-service's offer-field drafts, asks the Rating with its own run), so the copy keeps the parent.
ALTER TABLE "llm_call_copy" ADD COLUMN IF NOT EXISTS "parent_run_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engine_llm_picks_run_llm" ON "engine_llm_picks" ("run_id", "llm_dynasty_slug");
