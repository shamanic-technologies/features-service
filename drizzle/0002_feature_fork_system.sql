-- Add display_name column (human-readable, stable across forks)
ALTER TABLE "features" ADD COLUMN "display_name" text;

-- Backfill: copy existing name → display_name for all rows
UPDATE "features" SET "display_name" = "name" WHERE "display_name" IS NULL;

-- Make display_name NOT NULL after backfill
ALTER TABLE "features" ALTER COLUMN "display_name" SET NOT NULL;

-- Add fork lineage columns
ALTER TABLE "features" ADD COLUMN "forked_from" uuid;
ALTER TABLE "features" ADD COLUMN "upgraded_to" uuid;
