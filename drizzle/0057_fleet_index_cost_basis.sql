-- PUBLIC-VENDOR-COST-1031: every fleet index point states the cost basis its money is on. `billed` (every existing row, the
-- staff Research series) or `vendor` (the public indexes, real vendor cost before our markup, whole history). One row per
-- (index, day, basis). Additive.
ALTER TABLE "fleet_index_points" ADD COLUMN IF NOT EXISTS "cost_basis" text DEFAULT 'billed' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_fleet_index_points_slug_day";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_fleet_index_points_slug_day_basis" ON "fleet_index_points" USING btree ("index_slug","day","cost_basis");
