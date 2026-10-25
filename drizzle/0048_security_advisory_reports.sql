-- SEC-ADVISORIES-SERIES-1025: the daily dependency audit of every prod repo (npm/pnpm audit, run on the owner's Mac),
-- one row per (UTC day, repo). Re-sending a day replaces that day's rows. Read by the staff Monitoring hub.
CREATE TABLE IF NOT EXISTS "security_advisory_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" text NOT NULL,
	"repo" text NOT NULL,
	"critical" integer,
	"high" integer,
	"moderate" integer,
	"low" integer,
	"packages" text[] DEFAULT '{}' NOT NULL,
	"error" text,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_security_advisory_reports_day_repo" ON "security_advisory_reports" USING btree ("day","repo");
