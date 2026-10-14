-- TACTIC-JUDGING-STATE-1014 (owner 2026-10-14): the last full Jev sweep per tactic, so a tactic says whether its
-- judging is complete, still running, or FAILING (Jev out of credits looked "pending" forever to a client's agent).
CREATE TABLE IF NOT EXISTS "tactic_judging_sweeps" (
  "tactic_id" text PRIMARY KEY NOT NULL,
  "judged_description" text NOT NULL,
  "swept_at" timestamp with time zone NOT NULL,
  "versions" integer NOT NULL,
  "judged" integer NOT NULL,
  "failed" integer NOT NULL,
  "last_failure" text,
  "last_failure_at" timestamp with time zone
);
