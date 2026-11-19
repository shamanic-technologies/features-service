-- CAMPAIGN-CHANGE-LOG-1119. `campaign_engine_strategies` holds the strategy kept per (unit campaign, Engine) NOW and is
-- overwritten on every judgement: "which strategy did this Engine follow on the 4th" had no answer. From this migration
-- on, every write that CHANGES the kept strategy appends a row here (lib/engine-strategy-io.ts `writeEngineStrategy`).
-- Append-only, never updated or deleted; before = not recorded (no backfill).
CREATE TABLE IF NOT EXISTS "campaign_engine_strategy_changes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "campaign_id" text NOT NULL,
  "outcome" text NOT NULL,
  "org_id" text NOT NULL,
  "from_strategy_id" text,
  "to_strategy_id" text,
  "source" text NOT NULL,
  "confidence" double precision,
  "model" text,
  "changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_engine_strategy_changes_campaign_idx" ON "campaign_engine_strategy_changes" ("campaign_id", "changed_at");
