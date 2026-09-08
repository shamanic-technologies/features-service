CREATE TABLE IF NOT EXISTS "fleet_funnel_return_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_slug" text NOT NULL,
	"rows" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_fleet_funnel_return_snapshots_feature" ON "fleet_funnel_return_snapshots" USING btree ("feature_slug");
