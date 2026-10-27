-- FUNNEL-NAMES-NO-NUMBERS-1027 (owner 2026-10-27): a sales funnel's name never carries a number. Two funnels whose
-- every candidate is held SHARE their first one, so the name is unique per PIPE (`campaign:` keys) and per PATH
-- (`path:` keys) only, never across sales funnels.
ALTER TABLE "sales_path_combination_names" DROP CONSTRAINT IF EXISTS "sales_path_combination_names_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_path_combination_names_catalogue_name_unique" ON "sales_path_combination_names" ("name") WHERE "combination_key" LIKE 'campaign:%' OR "combination_key" LIKE 'path:%';
