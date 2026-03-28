-- Dynasty model: add base_name, fork_name, dynasty_slug, version columns
-- Rename display_name → dynasty_name

-- Step 1: Rename display_name to dynasty_name
ALTER TABLE "features" RENAME COLUMN "display_name" TO "dynasty_name";

-- Step 2: Add new columns (nullable temporarily for backfill)
ALTER TABLE "features" ADD COLUMN "base_name" text;
ALTER TABLE "features" ADD COLUMN "fork_name" text;
ALTER TABLE "features" ADD COLUMN "dynasty_slug" text;
ALTER TABLE "features" ADD COLUMN "version" integer NOT NULL DEFAULT 1;

-- Step 3: Backfill existing data
-- base_name = dynasty_name (all existing features are originals, no forks)
UPDATE "features" SET "base_name" = "dynasty_name";

-- dynasty_slug = slugified dynasty_name
UPDATE "features" SET "dynasty_slug" = lower(
  regexp_replace(
    regexp_replace("dynasty_name", '[^a-zA-Z0-9]+', '-', 'g'),
    '^-+|-+$', '', 'g'
  )
);

-- version = parsed from slug suffix (-vN → N, no suffix → 1)
UPDATE "features" SET "version" = CASE
  WHEN "slug" ~ '-v\d+$' THEN
    (regexp_replace("slug", '.*-v(\d+)$', '\1'))::integer
  ELSE 1
END;

-- Step 4: Set NOT NULL constraints after backfill
ALTER TABLE "features" ALTER COLUMN "base_name" SET NOT NULL;
ALTER TABLE "features" ALTER COLUMN "dynasty_slug" SET NOT NULL;

-- Step 5: Add unique constraint (one version per dynasty)
CREATE UNIQUE INDEX "idx_features_dynasty_version" ON "features" ("dynasty_slug", "version");

-- Step 6: Add index on base_name for fork_name generation queries
CREATE INDEX "idx_features_base_name" ON "features" ("base_name");
