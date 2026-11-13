-- SCRIPT-VALUE-RATING-1113: a Unit is named by its subject, and one subject holds several Units over time (a lead holds
-- every message written for them). `unit_at` = when the thing the client points at was made (a message's send time), so
-- the ledger resolves THAT Unit, not the latest one. Null = the Unit standing when the report was made.
ALTER TABLE "unit_client_reports" ADD COLUMN IF NOT EXISTS "unit_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unit_client_reports_org_subject" ON "unit_client_reports" ("org_id", "subject_service", "subject_id");
