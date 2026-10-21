-- RESEARCH-NICHE-1021: how specific each client's B2B niche is, per (org, brand, offer), judged once by Jev on what the
-- client sells and who its audiences target, re-judged only when that text changes. Read by the Research niche study.
CREATE TABLE IF NOT EXISTS "niche_grades" (
	"org_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"offer_id" text DEFAULT '' NOT NULL,
	"grade" text NOT NULL,
	"confidence" double precision NOT NULL,
	"probabilities" jsonb NOT NULL,
	"model" text NOT NULL,
	"judged_state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"judged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "niche_grades_pk" PRIMARY KEY("org_id","brand_id","offer_id")
);
