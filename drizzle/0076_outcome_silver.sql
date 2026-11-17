-- OUTCOME-FORECAST-1117 (owner 2026-11-17), SILVER. Our copy of the produced Units of runs-service's ledger (one row per
-- Unit, followed incrementally: `lib/outcome-units-copy.ts`) and the distributions measured on it per scope (campaign,
-- brand, fleet): cost per Unit, yield and delay of each transition (`lib/outcome-silver.ts`). Derived, rebuildable.
CREATE TABLE IF NOT EXISTS "outcome_units" (
  "id" uuid PRIMARY KEY NOT NULL,
  "outcome_key" text NOT NULL,
  "subject" text NOT NULL,
  "declared_at" timestamp with time zone NOT NULL,
  "org_id" text,
  "brand_id" text,
  "campaign_id" text,
  "cost_net_cents" double precision,
  "cost_gross_cents" double precision,
  "reversed" boolean DEFAULT false NOT NULL,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_units_subject" ON "outcome_units" ("subject", "outcome_key", "declared_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outcome_units_key" ON "outcome_units" ("outcome_key", "declared_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outcome_silver_stats" (
  "scope" text NOT NULL,
  "scope_id" text NOT NULL,
  "from_key" text NOT NULL,
  "to_key" text NOT NULL,
  "sample_size" double precision NOT NULL,
  "body" jsonb NOT NULL,
  "computed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "outcome_silver_stats_pk" PRIMARY KEY ("scope", "scope_id", "from_key", "to_key")
);
