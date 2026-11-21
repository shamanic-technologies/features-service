-- OUTREACH-3WAYS-1121: an OPT-IN script tactic. A script judged yes on it (it serves people who are not the offer's
-- buyers: the brand's investors, its industry peers) is kept ONLY for a campaign whose strategy REQUIRES the tactic, and
-- ruled out under no strategy, no brief or a strategy silent on it. No existing tactic is opt-in (default false).
ALTER TABLE "tactics" ADD COLUMN IF NOT EXISTS "opt_in" boolean NOT NULL DEFAULT false;
