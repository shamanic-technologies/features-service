-- LIFECYCLE-LADDER-1017 (owner 2026-10-17): every catalogue step states its rung on ONE absolute lifecycle ladder
-- (lib/lifecycle-ladder.ts). A declared step states its own; the two declared before today are set here.
ALTER TABLE "declared_steps" ADD COLUMN IF NOT EXISTS "lifecycle_rung" text;
--> statement-breakpoint
UPDATE "declared_steps" SET "lifecycle_rung" = 'engaged' WHERE "key" = 'industry_update_video' AND "lifecycle_rung" IS NULL;
--> statement-breakpoint
UPDATE "declared_steps" SET "lifecycle_rung" = 'contacted' WHERE "key" = 'email_sent' AND "lifecycle_rung" IS NULL;
