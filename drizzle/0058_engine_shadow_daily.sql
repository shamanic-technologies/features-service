-- ENGINE-PER-OUTCOME-SHADOW (owner 2026-10-31): the Engine-per-outcome shadow's daily counts beside the factory shadow's.
-- Shadow only: nothing reads them to decide what runs. Additive, idempotent.
ALTER TABLE "factory_shadow_daily" ADD COLUMN IF NOT EXISTS "engine_places" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_shadow_daily" ADD COLUMN IF NOT EXISTS "engine_agreed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_shadow_daily" ADD COLUMN IF NOT EXISTS "engine_today_share_sum" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "factory_shadow_daily" ADD COLUMN IF NOT EXISTS "engine_failed" integer DEFAULT 0 NOT NULL;
