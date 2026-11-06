-- MIGRATE-1105 S5 (owner 2026-11-06, OUTCOME-FINEST: « le QUOI c'est l'outcome, et il doit être toujours aussi fin que
-- possible »): a PIPE (channel x leg) names the outcome its Engine makes, the finest WHAT (Threads post published, Email
-- sent), when it is finer than the leg's `to` step (the funnel milestone). No row = the Engine of the pipe is its `to`
-- step, exactly as before. campaign-service dispatches the named Engine; the pipe's runnable scripts are that outcome's.
CREATE TABLE IF NOT EXISTS "pipe_engine_outcomes" (
  "channel_slug" text NOT NULL,
  "leg_key" text NOT NULL,
  "outcome" text NOT NULL,
  "declared_by" text NOT NULL,
  "declared_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipe_engine_outcomes_pk" PRIMARY KEY ("channel_slug", "leg_key")
);
