-- FACTORY-P2 (owner 2026-10-29): Monitoring red only for something broken; a plan waiting on a first price is counted apart. Additive.
ALTER TABLE "factory_shadow_daily" ADD COLUMN IF NOT EXISTS "not_yet" integer DEFAULT 0 NOT NULL;
