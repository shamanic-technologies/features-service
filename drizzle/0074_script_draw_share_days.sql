-- SCRIPT-VALUE-RATING-1113-MON: the Rating's share of draws per script, one row per (day, script dynasty), the latest
-- build of the day kept. Monitoring's chart of what each Engine favours over time reads it (a pick is never stored by
-- the runner per draw: this is the Rating's own forecast, 400 draws per Engine among its runnable scripts).
CREATE TABLE IF NOT EXISTS "script_draw_share_days" (
  "day" date NOT NULL,
  "script_dynasty" text NOT NULL,
  "outcome" text NOT NULL,
  "share_pct" double precision NOT NULL,
  "runs" integer NOT NULL,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "script_draw_share_days_pk" PRIMARY KEY ("day", "script_dynasty")
);
