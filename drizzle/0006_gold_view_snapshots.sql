CREATE TABLE IF NOT EXISTS "feature_view_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"view" text NOT NULL,
	"scope_key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"body" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshing_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_feature_view_snapshots_view_scope" ON "feature_view_snapshots" USING btree ("view","scope_key");
