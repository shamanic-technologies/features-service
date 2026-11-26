-- MODEL-TAG-EVERY-AI-MESSAGE-1126 (owner 2026-11-26, « remplacer ce tag automated par le tag où tu mettais le logo + nom
-- du LLM utilisé »): per UTC day and org, the messages our runs sent (runs-service `message_sent` Units) and how many
-- name the model that ACTUALLY wrote them (the LLM billed in the writing run, never the model a script asks for).
-- "messages" = AI messages (the sending run consumed a message_written Unit); a send that consumed none (a newsletter
-- release) is counted in sent_not_written_by_our_runs, never red. Dashboard v2 Monitoring charts « AI messages with no model named ». org_id '' = a send whose run names no org.
CREATE TABLE IF NOT EXISTS "ai_message_model_days" (
  "day" date NOT NULL,
  "org_id" text NOT NULL,
  "sent_not_written_by_our_runs" integer NOT NULL,
  "messages" integer NOT NULL,
  "with_model" integer NOT NULL,
  "without_model" integer NOT NULL,
  "without_by_reason" jsonb NOT NULL,
  "by_model" jsonb NOT NULL,
  "rule" text NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_message_model_days_pk" PRIMARY KEY ("day", "org_id")
);
