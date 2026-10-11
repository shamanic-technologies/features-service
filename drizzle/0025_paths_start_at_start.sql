-- A proactive sales path goes from Start to Paid client (owner 2026-10-11): an outbound path's id gains its sourcing
-- leg `start_to_lead_found+`. Its stored name moves with it (Ganges stays Ganges); the old id stays an alias at read.
UPDATE "sales_path_combination_names" AS n
SET "combination_key" = 'path:start_to_lead_found+' || substr(n."combination_key", 6)
WHERE n."combination_key" LIKE 'path:lead\_found\_to\_%'
  AND NOT EXISTS (
    SELECT 1 FROM "sales_path_combination_names" AS m
    WHERE m."combination_key" = 'path:start_to_lead_found+' || substr(n."combination_key", 6)
  );
--> statement-breakpoint
UPDATE "declared_sales_path_chains" AS c
SET "path_id" = 'start_to_lead_found+' || c."path_id",
    "leg_keys" = '["start_to_lead_found"]'::jsonb || c."leg_keys"
WHERE c."path_id" LIKE 'lead\_found\_to\_%'
  AND NOT EXISTS (SELECT 1 FROM "declared_sales_path_chains" AS d WHERE d."path_id" = 'start_to_lead_found+' || c."path_id");
