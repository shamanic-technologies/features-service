-- BRIEF-DAILY-CAP-1125 (owner 2026-11-25; framework v10 §6 « Daily caps in the brief become most Units per day at an
-- Engine. … The verdicts are stored on the campaign. »): the most Units a campaign's BRIEF allows per Engine. One answer
-- of Jev per (campaign, Engine), stored with the brief it was judged on (re-asked when the brief or the rule moves).
-- "units" NULL = the brief states no limit on this Engine: no cap. "per" = the period as stated (day | week | month).
-- Empty at creation: no campaign is capped until its brief is judged to state a limit. Served to the Engine runner, which
-- enforces it; nothing here holds a run.
CREATE TABLE IF NOT EXISTS "campaign_brief_most_units" (
  "campaign_id" text NOT NULL,
  "outcome" text NOT NULL,
  "org_id" text NOT NULL,
  "units" integer,
  "per" text,
  "probability" double precision NOT NULL,
  "confidence" double precision,
  "model" text NOT NULL,
  "brief_hash" text NOT NULL,
  "rule" text NOT NULL,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "campaign_brief_most_units_pk" PRIMARY KEY ("campaign_id", "outcome")
);
