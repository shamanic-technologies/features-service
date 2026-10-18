-- LIVE-RESEARCH-1018: features-service's copy of instantly-service's outreach-facts feed (one row per subject, its
-- latest statement), read by the Research follow-up, timing, open-tracking and machine-reply studies.
CREATE TABLE IF NOT EXISTS "outreach_fact_copy" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"org_id" text,
	"campaign_id" text,
	"instantly_campaign_id" text NOT NULL,
	"lead_email" text NOT NULL,
	"transport" text,
	"step" integer,
	"local_sent_at" text,
	"local_weekday" text,
	"timezone" text,
	"open_tracking" text,
	"reply_kind" text,
	"reply_classification" text,
	"reply_automated" boolean,
	"withdrawn" boolean DEFAULT false NOT NULL,
	"copied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outreach_fact_copy_campaign_type" ON "outreach_fact_copy" USING btree ("campaign_id","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_outreach_fact_copy_thread" ON "outreach_fact_copy" USING btree ("instantly_campaign_id","lead_email");
