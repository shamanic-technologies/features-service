-- FACTORY-P1-BRIEF-PREFILL (2026-10-28): the briefs features-service prefilled on funnel campaigns (once per campaign).
CREATE TABLE IF NOT EXISTS "factory_brief_prefills" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brief" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
