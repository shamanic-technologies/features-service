ALTER TABLE "feature_view_snapshots" ADD COLUMN IF NOT EXISTS "family_key" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feature_view_snapshots_family" ON "feature_view_snapshots" USING btree ("view","family_key","computed_at");
