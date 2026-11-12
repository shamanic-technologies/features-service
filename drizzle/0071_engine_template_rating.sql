-- LLM-RATING-PER-ENGINE-1112 phase 2 (owner 2026-11-12 via missoula-v12): the Rating picks TEMPLATES per Engine place
-- like LLMs. engine_template_picks = every template pick answered; template_decisions = which template dynasty each
-- decision (run) wrote with: the thread generation feed and our sequence copy (history) + every pick (from now on).
CREATE TABLE IF NOT EXISTS "engine_template_picks" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "outcome" text NOT NULL,
  "place" text NOT NULL,
  "template_dynasty_slug" text NOT NULL,
  "run_id" text,
  "campaign_id" text,
  "picked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engine_template_picks_outcome_at" ON "engine_template_picks" ("outcome", "picked_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "engine_template_picks_run" ON "engine_template_picks" ("run_id", "template_dynasty_slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_decisions" (
  "decision_run_id" text NOT NULL,
  "template_dynasty_slug" text NOT NULL,
  "source" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "template_decisions_pk" PRIMARY KEY ("decision_run_id", "template_dynasty_slug")
);
