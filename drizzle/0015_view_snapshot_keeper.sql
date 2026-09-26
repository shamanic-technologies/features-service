ALTER TABLE "feature_view_snapshots" ADD COLUMN IF NOT EXISTS "replay_url" text;--> statement-breakpoint
ALTER TABLE "feature_view_snapshots" ADD COLUMN IF NOT EXISTS "replay_headers" jsonb;--> statement-breakpoint
ALTER TABLE "feature_view_snapshots" ADD COLUMN IF NOT EXISTS "brand_id" text;--> statement-breakpoint
ALTER TABLE "feature_view_snapshots" ADD COLUMN IF NOT EXISTS "facts_fingerprint" text;--> statement-breakpoint
ALTER TABLE "feature_view_snapshots" ADD COLUMN IF NOT EXISTS "last_read_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feature_view_snapshots_brand_read" ON "feature_view_snapshots" USING btree ("brand_id","last_read_at");
