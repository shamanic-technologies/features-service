-- MIGRATE-1105 S6 (owner via orchestrator 2026-11-08): a brief silent on a point never WIDENS what a campaign runs. A
-- strategy may be the conservative DEFAULT of one or more Engines (outcomes): the brief judge keeps it when nothing in
-- the brief bears on that Engine, instead of "no condition" (every script: every lead source, CRM contacts included,
-- the client-mailbox sending script). Data, never a code branch per Engine. Seeded with the defaults the campaigns ran
-- on those Engines before plays were removed.
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "default_for_outcomes" text[] DEFAULT '{}'::text[] NOT NULL;
UPDATE "strategies" SET "default_for_outcomes" = ARRAY['lead_found'] WHERE "id" = 'valid-only';
UPDATE "strategies" SET "default_for_outcomes" = ARRAY['email_sent'] WHERE "id" = 'our-own-emails';
UPDATE "strategies" SET "default_for_outcomes" = ARRAY['paid_client', 'message_sent'] WHERE "id" = 'leads-only-written-by-glm';
