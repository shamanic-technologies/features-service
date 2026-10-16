-- CATALOGUE-RETIRE-1016 (2026-10-16): a declared trigger or sales funnel created by mistake can be RETIRED through the
-- catalogue (POST /internal/catalogue/triggers/{id}/retire, POST /internal/catalogue/sales-funnels/{id}/retire): out of
-- every catalogue read, the row kept for history. A retired trigger's name may be given again (partial unique index).
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "retired_by" text;
--> statement-breakpoint
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "retire_note" text;
--> statement-breakpoint
ALTER TABLE "declared_sales_paths" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "declared_sales_paths" ADD COLUMN IF NOT EXISTS "retired_by" text;
--> statement-breakpoint
ALTER TABLE "declared_sales_paths" ADD COLUMN IF NOT EXISTS "retire_note" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "channel_trigger_types_label_lower_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_trigger_types_label_lower_unique" ON "channel_trigger_types" (lower("label")) WHERE "retired_at" IS NULL;
