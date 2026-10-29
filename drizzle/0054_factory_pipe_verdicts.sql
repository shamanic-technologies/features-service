-- FACTORY-P1 pipe judge (2026-10-29): per funnel campaign x pipe, whether its brief rules the pipe out. Additive.
CREATE TABLE IF NOT EXISTS "factory_pipe_verdicts" (
	"campaign_id" text NOT NULL,
	"pipe_id" text NOT NULL,
	"org_id" text NOT NULL,
	"brief_hash" text NOT NULL,
	"pipe_signature" text NOT NULL,
	"excluded" boolean NOT NULL,
	"probability" double precision NOT NULL,
	"model" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_pipe_verdicts_campaign_id_pipe_id_pk" PRIMARY KEY("campaign_id","pipe_id")
);
