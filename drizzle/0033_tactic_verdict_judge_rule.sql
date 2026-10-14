-- TACTIC-JUDGE-WHOLE-DAG-1014 (2026-10-14): Jev read a workflow DAG cut at 60,000 characters, so a step past the cut
-- (ai-meeting-booking-torcular-v4's document attachment, at char ~79,000 of 103,000) was never seen and the tactic was
-- judged "no". Every stored verdict records the rule it was judged under; the sweep re-judges the verdicts of the
-- versions whose DAG did not fit, now read whole, in parts.
ALTER TABLE "workflow_tactic_verdicts" ADD COLUMN IF NOT EXISTS "judge_rule" text DEFAULT 'truncated-60k' NOT NULL;
