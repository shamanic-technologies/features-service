-- FACTORY-P1-BRIEF-JUDGE-SHADOW-PLAN (2026-10-28): the brief judge's verdicts, the shadow plans and their daily Monitoring
-- series. Shadow only: nothing reads them to decide what a campaign runs. Additive, idempotent.
CREATE TABLE IF NOT EXISTS "factory_brief_judgments" (
	"campaign_id" text NOT NULL,
	"base_pipe_id" text NOT NULL,
	"org_id" text NOT NULL,
	"brief_hash" text,
	"brief_updated_at" timestamp with time zone,
	"plays_signature" text NOT NULL,
	"chosen_pipe_id" text NOT NULL,
	"default_pipe_id" text NOT NULL,
	"confidence" double precision,
	"probabilities" jsonb,
	"model" text,
	"source" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factory_brief_judgments_campaign_id_base_pipe_id_pk" PRIMARY KEY("campaign_id","base_pipe_id")
);
CREATE TABLE IF NOT EXISTS "factory_shadow_plans" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"status" text NOT NULL,
	"failure" text,
	"body" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "factory_shadow_daily" (
	"day" text NOT NULL,
	"org_id" text NOT NULL,
	"campaigns" integer NOT NULL,
	"plan_differs" integer NOT NULL,
	"pick_differs" integer NOT NULL,
	"differs" integer NOT NULL,
	"judge_failed" integer NOT NULL,
	"plan_failed" integer NOT NULL,
	"swept_at" timestamp with time zone NOT NULL,
	CONSTRAINT "factory_shadow_daily_day_org_id_pk" PRIMARY KEY("day","org_id")
);
