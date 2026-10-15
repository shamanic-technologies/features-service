-- MCP-PIPE-GAPS-1015 (2026-10-15): a declared pipe created by mistake (no campaign uses it) can be RETIRED through the
-- catalogue (POST /internal/catalogue/pipes/{id}/retire): out of every catalogue read, the row kept for history.
ALTER TABLE "declared_channel_legs" ADD COLUMN IF NOT EXISTS "retired_at" timestamp with time zone;
ALTER TABLE "declared_channel_legs" ADD COLUMN IF NOT EXISTS "retired_by" text;
ALTER TABLE "declared_channel_legs" ADD COLUMN IF NOT EXISTS "retire_note" text;
