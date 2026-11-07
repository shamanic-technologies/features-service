-- MIGRATE-1105 S6 (owner 2026-11-07: « les pipe sont supprimés depuis longtemps non?? Meme les legs non???? »): a
-- campaign's STRATEGY is kept PER ENGINE (one outcome), judged from its brief and stored on the campaign. No pipe, leg,
-- play, sales funnel id or default play decides which scripts an Engine may run. `strategy_id` NULL = no condition
-- (every script of the Engine). `source`: `carried` = written once by the S6 migration from what the campaign ran on
-- that day (its play), held while its brief is unchanged; `judge` = Jev's pick from the brief; `empty_brief` = no brief,
-- no condition. A brief that moves re-judges the row (`brief_hash`).
CREATE TABLE IF NOT EXISTS "campaign_engine_strategies" (
  "campaign_id" text NOT NULL,
  "outcome" text NOT NULL,
  "org_id" text NOT NULL,
  "strategy_id" text,
  "source" text NOT NULL,
  "brief_hash" text,
  "options_signature" text,
  "confidence" double precision,
  "model" text,
  "carried_from" text,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_engine_strategies_pk" PRIMARY KEY ("campaign_id", "outcome")
);
