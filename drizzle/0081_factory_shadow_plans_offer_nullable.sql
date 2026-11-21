-- DISTRY-CALL-IS-CAMPAIGN-1121 (owner 2026-11-21): a campaign is Target + start + budget + brief, the offer is optional.
-- A campaign launched on its Target alone may name no offer: its stored plan keeps offer_id NULL, never a placeholder.
ALTER TABLE "factory_shadow_plans" ALTER COLUMN "offer_id" DROP NOT NULL;
