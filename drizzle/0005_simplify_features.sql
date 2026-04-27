-- Migration: Remove dynasty model and unused metadata columns.
-- Keeps definition fields (inputs, outputs, charts, entities, icon, display_order, implemented).
-- Consolidates 11 features into 5 canonical features.

-- Step 1: Delete all non-canonical features (clears slug conflicts for renaming)
DELETE FROM features WHERE id NOT IN (
  'ed88d640-5289-43e1-b53b-38ddde70b326',
  '980199db-a698-4345-a988-47659067c82e',
  'a4f701ef-c27a-46b4-8d4f-ff71029dec35',
  'dae95f2a-5bb1-4cbd-b54a-026a1183ab3b',
  'f8e092bc-f2bf-4a0d-a2ff-7152681a0a19'
);

-- Step 2: Rename kept features to canonical slugs/names
UPDATE features SET slug = 'sales-cold-email-outreach', name = 'Sales Cold Email Outreach', status = 'active', updated_at = NOW() WHERE id = 'ed88d640-5289-43e1-b53b-38ddde70b326';
UPDATE features SET slug = 'pr-cold-email-outreach', name = 'PR Cold Email Outreach', status = 'active', updated_at = NOW() WHERE id = '980199db-a698-4345-a988-47659067c82e';
UPDATE features SET slug = 'press-kit-page-generation', name = 'Press Kit Page Generation', status = 'active', updated_at = NOW() WHERE id = 'f8e092bc-f2bf-4a0d-a2ff-7152681a0a19';

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
