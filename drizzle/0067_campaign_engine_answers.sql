-- NEXT-STEPS-TRUE-REASON-1111: the latest Engine runner answer per (pipe campaign, Engine), read by the campaign next-steps.
CREATE TABLE IF NOT EXISTS "campaign_engine_answers" (
  "campaign_id" text NOT NULL,
  "outcome" text NOT NULL,
  "held_reason" text,
  "first_held_at" timestamp with time zone,
  "answered_at" timestamp with time zone NOT NULL,
  CONSTRAINT "campaign_engine_answers_pk" PRIMARY KEY ("campaign_id", "outcome")
);
