-- SCRIPT-VALUE-RATING-1113 (owner 2026-11-13): a client says a Unit we made is not good: an edit of what we wrote
-- (`edited`) or a "Report" (`reported`), from the dashboard, the API, the MCP or Sophie. The Rating reads a reported
-- Unit as worth nothing for the script that made it; silence says nothing. Append-only.
CREATE TABLE IF NOT EXISTS "unit_client_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL,
  "outcome_key" text NOT NULL,
  "subject_service" text NOT NULL,
  "subject_id" text NOT NULL,
  "kind" text NOT NULL,
  "source" text NOT NULL,
  "note" text,
  "reported_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "unit_client_reports_kind_check" CHECK ("kind" IN ('edited', 'reported'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_client_reports_unit" ON "unit_client_reports" ("outcome_key", "subject_service", "subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_client_reports_at" ON "unit_client_reports" ("reported_at");
