-- LLM-RATING-PER-ENGINE-1112 (owner 2026-11-12: « Ce n'est pas normal qu'on ait des scripts qui tournent sur du Fable ou
-- du Opus »; option A: the Rating rates LLMs per Engine like any candidate). Two stores:
-- 1. engine_llm_universes: which LLM dynasties an Engine may use. outcome '*' = every Engine with no row of its own.
--    allowed NULL = every LLM dynasty chat-service serves today; excluded = taken out of that set.
--    Seeded: every Engine, every served LLM except Claude Fable and Claude Opus (owner 2026-11-12).
-- 2. engine_llm_picks: every pick the Rating answered (which Engine, which LLM call place, which LLM, for which run),
--    so a call's place is known and the staff read serves each LLM's share of picks.
CREATE TABLE IF NOT EXISTS "engine_llm_universes" (
  "outcome" text PRIMARY KEY NOT NULL,
  "allowed" text[],
  "excluded" text[] DEFAULT '{}' NOT NULL,
  "decided_by" text NOT NULL,
  "note" text,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "engine_llm_universes" ("outcome", "allowed", "excluded", "decided_by", "note")
VALUES ('*', NULL, ARRAY['claude-fable', 'claude-opus'], 'owner', 'LLM-RATING-PER-ENGINE-1112: every served LLM except Claude Fable and Claude Opus (owner 2026-11-12)')
ON CONFLICT ("outcome") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "engine_llm_picks" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "outcome" text NOT NULL,
  "place" text NOT NULL,
  "llm_dynasty_slug" text NOT NULL,
  "run_id" text,
  "campaign_id" text,
  "picked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engine_llm_picks_outcome_at" ON "engine_llm_picks" ("outcome", "picked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engine_llm_picks_run" ON "engine_llm_picks" ("run_id");
--> statement-breakpoint
-- 3. Our copy of runs-service's chat-service calls (service-calls feed): one row per LLM call, filed at copy time under
--    its Engine (script outcome, else its workflow's pipe outcome) and its LLM dynasty (chat-service cost-name map).
CREATE TABLE IF NOT EXISTS "llm_call_copy" (
  "call_run_id" text PRIMARY KEY NOT NULL,
  "decision_run_id" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "script_slug" text,
  "workflow_slug" text,
  "outcome" text,
  "llm_dynasty_slug" text,
  "cost_names" text[] DEFAULT '{}' NOT NULL,
  "spent_usd" numeric NOT NULL,
  "support_function" text,
  "copied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_copy_engine" ON "llm_call_copy" ("outcome", "llm_dynasty_slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_copy_decision" ON "llm_call_copy" ("decision_run_id");
--> statement-breakpoint
-- 4. The Units runs-service's ledger credits to each decision (own + one hop downstream), per outcome key; re-read
--    when its changes feed names the decision (read_at NULL = to read).
CREATE TABLE IF NOT EXISTS "llm_decision_units" (
  "decision_run_id" text PRIMARY KEY NOT NULL,
  "units" jsonb,
  "read_at" timestamp with time zone
);
