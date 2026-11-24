-- PLAN-RECURSIVE-PER-ENGINE-1124-SOURCES (owner 2026-11-24): what a campaign's BRIEF asks for, per Engine x opt-in script
-- tactic. One yes/no answer of Jev per (campaign, Engine, tactic), stored with the brief and the tactic description it was
-- judged on (re-asked when either moves). Read beside the campaign's strategy wherever the opt-in rule is read: a script
-- judged yes on an opt-in tactic runs where the strategy requires it OR the brief asks for it. Empty at creation: no
-- campaign gains or loses a script until its brief is judged to ask.
CREATE TABLE IF NOT EXISTS "campaign_brief_opt_in_asks" (
  "campaign_id" text NOT NULL,
  "outcome" text NOT NULL,
  "tactic_id" text NOT NULL,
  "org_id" text NOT NULL,
  "asks" boolean NOT NULL,
  "probability" double precision NOT NULL,
  "model" text NOT NULL,
  "brief_hash" text NOT NULL,
  "judged_description" text NOT NULL,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_brief_opt_in_asks_pk" PRIMARY KEY ("campaign_id", "outcome", "tactic_id")
);
