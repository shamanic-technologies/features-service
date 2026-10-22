-- BEST-TPL-LLM-1022 (owner 2026-10-22): a tactic tags a workflow VERSION (as before), a template DYNASTY or an LLM, so a
-- strategy can narrow the templates and LLMs a pipe writes with. Every existing tactic stays a workflow tactic.
ALTER TABLE "tactics" ADD COLUMN IF NOT EXISTS "applies_to" text DEFAULT 'workflow' NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "writer_tactic_verdicts" (
  "subject_kind" text NOT NULL,
  "subject_key" text NOT NULL,
  "tactic_id" text NOT NULL,
  "subject_version" text NOT NULL,
  "verdict" boolean NOT NULL,
  "probability" double precision NOT NULL,
  "model" text NOT NULL,
  "judged_description" text NOT NULL,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "writer_tactic_verdicts_pk" PRIMARY KEY ("subject_kind", "subject_key", "tactic_id")
);
