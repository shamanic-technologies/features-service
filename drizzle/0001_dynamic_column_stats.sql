-- Add entities column (required, default to empty array for migration)
ALTER TABLE "features" ADD COLUMN "entities" jsonb DEFAULT '[]'::jsonb NOT NULL;

-- Drop removed columns
ALTER TABLE "features" DROP COLUMN IF EXISTS "workflow_columns";
ALTER TABLE "features" DROP COLUMN IF EXISTS "result_component";
ALTER TABLE "features" DROP COLUMN IF EXISTS "default_workflow_name";

-- Remove default from entities (it was only for migration safety)
ALTER TABLE "features" ALTER COLUMN "entities" DROP DEFAULT;

-- Remove default from charts (now required, not optional)
ALTER TABLE "features" ALTER COLUMN "charts" DROP DEFAULT;
