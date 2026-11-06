-- OUTCOME-RUNG-AND-TARGET-1106 (owner 2026-11-06): every outcome of the infra exists in ONE catalogue table and states
-- which rung of the ONE generic lead Lifecycle it reaches (or `none`: a post, a template, a rating has no lead). The
-- coded steps' rungs were a map in code (`CODED_STEP_LIFECYCLE_RUNGS`); declared steps held theirs on `declared_steps`.
-- Both move here, values unchanged; `declared_steps.lifecycle_rung` is no longer read nor written.
CREATE TABLE IF NOT EXISTS "outcome_lifecycle_rungs" (
  "outcome_key" text PRIMARY KEY NOT NULL,
  "lifecycle_rung" text NOT NULL,
  "stated_by" text NOT NULL,
  "stated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outcome_lifecycle_rungs_rung_check" CHECK ("lifecycle_rung" IN ('lead_found', 'contacted', 'engaged', 'signup_or_form', 'meeting_booked', 'meeting_attended', 'paid_client', 'none'))
);--> statement-breakpoint
INSERT INTO "outcome_lifecycle_rungs" ("outcome_key", "lifecycle_rung", "stated_by") VALUES
  ('lead_found', 'lead_found', 'migration-0061'),
  ('conversation', 'engaged', 'migration-0061'),
  ('website_visit', 'engaged', 'migration-0061'),
  ('booking_call', 'engaged', 'migration-0061'),
  ('signup', 'signup_or_form', 'migration-0061'),
  ('form_submitted', 'signup_or_form', 'migration-0061'),
  ('meeting_booked', 'meeting_booked', 'migration-0061'),
  ('meeting_attended', 'meeting_attended', 'migration-0061'),
  ('purchase', 'paid_client', 'migration-0061'),
  ('paid_client', 'paid_client', 'migration-0061'),
  ('lead_interested', 'engaged', 'migration-0061'),
  ('lead_visited', 'engaged', 'migration-0061')
ON CONFLICT ("outcome_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "outcome_lifecycle_rungs" ("outcome_key", "lifecycle_rung", "stated_by")
SELECT "key", "lifecycle_rung", 'migration-0061:declared_steps' FROM "declared_steps"
WHERE "lifecycle_rung" IN ('lead_found', 'contacted', 'engaged', 'signup_or_form', 'meeting_booked', 'meeting_attended', 'paid_client', 'none')
ON CONFLICT ("outcome_key") DO NOTHING;
