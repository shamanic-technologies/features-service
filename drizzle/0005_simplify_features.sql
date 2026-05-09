-- Migration: Remove dynasty model and unused metadata columns.
-- Idempotent — safe to run on any environment, only drops columns that still exist.
-- Original DELETE/UPDATE statements removed: the canonical 5 features already
-- have the correct slugs in staging and prod, and re-running with hardcoded
-- staging UUIDs would be destructive on other environments.

-- Drop dynasty indexes (no-op if already dropped)
DROP INDEX IF EXISTS "idx_features_dynasty_version";
DROP INDEX IF EXISTS "idx_features_signature";
DROP INDEX IF EXISTS "idx_features_base_name";

-- Drop dynasty columns
ALTER TABLE features DROP COLUMN IF EXISTS base_name;
ALTER TABLE features DROP COLUMN IF EXISTS fork_name;
ALTER TABLE features DROP COLUMN IF EXISTS dynasty_name;
ALTER TABLE features DROP COLUMN IF EXISTS dynasty_slug;
ALTER TABLE features DROP COLUMN IF EXISTS version;
ALTER TABLE features DROP COLUMN IF EXISTS signature;
ALTER TABLE features DROP COLUMN IF EXISTS forked_from;
ALTER TABLE features DROP COLUMN IF EXISTS upgraded_to;

-- Drop unused metadata columns
ALTER TABLE features DROP COLUMN IF EXISTS category;
ALTER TABLE features DROP COLUMN IF EXISTS channel;
ALTER TABLE features DROP COLUMN IF EXISTS audience_type;
