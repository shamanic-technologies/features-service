-- Migration: Remove dynasty model and unused metadata columns.
-- Keeps definition fields (inputs, outputs, charts, entities, icon, display_order, implemented).
-- Consolidates features into 5 canonical slugs.

-- Step 1: Delete all non-canonical features (keep one active per canonical concept)
DELETE FROM features WHERE id NOT IN (
  '81bbf5d8-aa1d-4cbc-93c8-5613ba481e19',
  '980199db-a698-4345-a988-47659067c82e',
  '302aaa65-0711-43c5-8182-9b2454ba07ac',
  'dae95f2a-5bb1-4cbd-b54a-026a1183ab3b',
  'f8e092bc-f2bf-4a0d-a2ff-7152681a0a19'
);

-- Step 2: Rename kept features to canonical slugs/names
UPDATE features SET slug = 'sales-cold-email-outreach', name = 'Sales Cold Email Outreach', status = 'active', updated_at = NOW() WHERE id = '81bbf5d8-aa1d-4cbc-93c8-5613ba481e19';
UPDATE features SET slug = 'pr-cold-email-outreach', name = 'PR Cold Email Outreach', status = 'active', updated_at = NOW() WHERE id = '980199db-a698-4345-a988-47659067c82e';
UPDATE features SET slug = 'hiring-cold-email-outreach', name = 'Hiring Cold Email Outreach', status = 'active', updated_at = NOW() WHERE id = '302aaa65-0711-43c5-8182-9b2454ba07ac';
UPDATE features SET slug = 'press-kit-page-generation', name = 'Press Kit Page Generation', status = 'active', updated_at = NOW() WHERE id = 'f8e092bc-f2bf-4a0d-a2ff-7152681a0a19';
-- outlet-database-discovery already has the canonical slug, just ensure active
UPDATE features SET status = 'active', updated_at = NOW() WHERE id = 'dae95f2a-5bb1-4cbd-b54a-026a1183ab3b';

-- Step 3: Drop dynasty indexes
DROP INDEX IF EXISTS "idx_features_dynasty_version";
DROP INDEX IF EXISTS "idx_features_signature";
DROP INDEX IF EXISTS "idx_features_base_name";

-- Step 4: Drop dynasty columns
ALTER TABLE features DROP COLUMN IF EXISTS base_name;
ALTER TABLE features DROP COLUMN IF EXISTS fork_name;
ALTER TABLE features DROP COLUMN IF EXISTS dynasty_name;
ALTER TABLE features DROP COLUMN IF EXISTS dynasty_slug;
ALTER TABLE features DROP COLUMN IF EXISTS version;
ALTER TABLE features DROP COLUMN IF EXISTS signature;
ALTER TABLE features DROP COLUMN IF EXISTS forked_from;
ALTER TABLE features DROP COLUMN IF EXISTS upgraded_to;

-- Step 5: Drop unused metadata columns
ALTER TABLE features DROP COLUMN IF EXISTS category;
ALTER TABLE features DROP COLUMN IF EXISTS channel;
ALTER TABLE features DROP COLUMN IF EXISTS audience_type;
