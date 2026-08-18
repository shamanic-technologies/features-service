ALTER TABLE "features" ADD COLUMN IF NOT EXISTS "sales_funnels" jsonb DEFAULT '[]'::jsonb NOT NULL;
