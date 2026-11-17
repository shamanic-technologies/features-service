-- UNIT-LINKS-CONSUME-1117. Our copy of the links runs-service STORES between two Units (which Unit a Unit came from, both
-- dates, the campaign(s) each carries): `GET /internal/stats/outcome-chains/unit-links`, copied whole once then followed
-- by cursor (`lib/outcome-silver-io.ts`). Silver reads every delay and every pair off it. Derived, rebuildable.
CREATE TABLE IF NOT EXISTS "outcome_unit_links" (
  "from_unit_id" uuid NOT NULL,
  "to_unit_id" uuid NOT NULL,
  "from_key" text NOT NULL,
  "to_key" text NOT NULL,
  "from_at" timestamp with time zone NOT NULL,
  "to_at" timestamp with time zone NOT NULL,
  "delay_seconds" double precision NOT NULL,
  "from_campaign_ids" text[] NOT NULL,
  "to_campaign_id" text,
  "to_campaign_ids" text[] NOT NULL,
  "from_brand_id" text,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "outcome_unit_links_pk" PRIMARY KEY ("from_unit_id", "to_unit_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_unit_links_to_unit" ON "outcome_unit_links" ("to_unit_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_unit_links_from_key" ON "outcome_unit_links" ("from_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_unit_links_carried" ON "outcome_unit_links" USING gin ("to_campaign_ids") WHERE "to_campaign_id" IS NULL;
--> statement-breakpoint
-- The index that served the read-side pairing by subject (deleted: the links are the one source of a pair).
DROP INDEX IF EXISTS "outcome_units_subject";
