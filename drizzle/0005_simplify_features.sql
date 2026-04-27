-- Migration: Simplify features table
-- Removes dynasty model, inputs, outputs, charts, entities, signature, and all versioning.
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

-- Step 3: Drop indexes that reference columns being removed
DROP INDEX IF EXISTS "idx_features_dynasty_version";
DROP INDEX IF EXISTS "idx_features_signature";

-- Step 4: Drop columns
ALTER TABLE features DROP COLUMN IF EXISTS base_name;
ALTER TABLE features DROP COLUMN IF EXISTS fork_name;
ALTER TABLE features DROP COLUMN IF EXISTS dynasty_name;
ALTER TABLE features DROP COLUMN IF EXISTS dynasty_slug;
ALTER TABLE features DROP COLUMN IF EXISTS version;
ALTER TABLE features DROP COLUMN IF EXISTS signature;
ALTER TABLE features DROP COLUMN IF EXISTS forked_from;
ALTER TABLE features DROP COLUMN IF EXISTS upgraded_to;
ALTER TABLE features DROP COLUMN IF EXISTS inputs;
ALTER TABLE features DROP COLUMN IF EXISTS outputs;
ALTER TABLE features DROP COLUMN IF EXISTS charts;
ALTER TABLE features DROP COLUMN IF EXISTS entities;
ALTER TABLE features DROP COLUMN IF EXISTS icon;
ALTER TABLE features DROP COLUMN IF EXISTS category;
ALTER TABLE features DROP COLUMN IF EXISTS channel;
ALTER TABLE features DROP COLUMN IF EXISTS audience_type;
ALTER TABLE features DROP COLUMN IF EXISTS display_order;
ALTER TABLE features DROP COLUMN IF EXISTS implemented;
