-- ENGINE-PER-OUTCOME-SWITCH (owner 2026-11-01): per UNIT campaign (one pipe) whose funnel campaign hands that pipe's
-- result to the Engine (campaign-service `engine_outcomes`), the workflow the Engine drives its pick to, since when, and
-- the roll-back guard. Written by the stored factory pass, read by the leg-keyed workflow-projection. Additive.
CREATE TABLE IF NOT EXISTS "engine_drives" (
	"unit_campaign_id" text PRIMARY KEY NOT NULL,
	"funnel_campaign_id" text NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"outcome" text NOT NULL,
	"pipe_id" text NOT NULL,
	"workflow_dynasty_slug" text NOT NULL,
	"service_dynasty_slug" text,
	"state" text NOT NULL,
	"switched_at" timestamp with time zone NOT NULL,
	"rolled_back_at" timestamp with time zone,
	"guard" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
