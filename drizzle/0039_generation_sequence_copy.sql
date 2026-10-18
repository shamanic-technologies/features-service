-- LIVE-RESEARCH-1018: features-service's copy of content-generation-service's sequence feed (one row per generated
-- sequence: which model and template wrote it, how its first email reads), read by the Research LLM, template, naming
-- and first-email studies through the fleet person cell.
CREATE TABLE IF NOT EXISTS "generation_sequence_copy" (
	"generation_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"model" text NOT NULL,
	"prompt_type" text,
	"workflow_slug" text,
	"created_at" timestamp with time zone NOT NULL,
	"layout" text,
	"opening" text,
	"dash" text,
	"copied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_generation_sequence_copy_campaign_lead" ON "generation_sequence_copy" USING btree ("campaign_id","lead_id");
