-- WRITTEN-BY-1019 (owner 2026-10-19): a client may read, on every message we sent for them, the tactics of the
-- workflow version that wrote it. A tactic's `description` is what Jev judges (service paths, field names), never
-- client copy: `client_line` is the plain line a client reads. Null = the tactic is not shown to clients yet.
ALTER TABLE "tactics" ADD COLUMN IF NOT EXISTS "client_line" text;
--> statement-breakpoint
UPDATE "tactics" AS t SET "client_line" = m."line"
FROM (VALUES
	('answers-leads-only', 'Replies to prospects only, never to your contacts or clients'),
	('attaches-offer-documents', 'Attaches the offer document that fits the question asked'),
	('blind-angle', 'Brand not named in the first email'),
	('business-contacts-only', 'Writes to business contacts only'),
	('catch-all', 'Also reaches addresses the mail server cannot confirm'),
	('contacted-pure-prospects', 'Follows up with prospects you already emailed'),
	('email-reach', 'Reaches people by email'),
	('email-replies-only', 'Answers email replies only'),
	('fresh-contacts-only', 'Skips anyone you emailed in the last 3 months'),
	('lead-follow-up-due', 'Follows up when a lead''s follow-up date arrives'),
	('named-angle', 'Brand named in the email'),
	('offer-angle', 'First email opens with something free'),
	('phone-reach', 'Reaches people by phone'),
	('skips-people-who-already-wrote', 'Skips people who already wrote to you'),
	('skips-the-brand-s-team', 'Never writes to your own team'),
	('unknown-email', 'Also reaches addresses the verifier could not check'),
	('warm-never-converted', 'Reaches CRM contacts who filled a form or met you'),
	('website-visit', 'Writes only to people who visited your website')
) AS m("id", "line")
WHERE t."id" = m."id" AND t."client_line" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_generation_sequence_copy_org_lead" ON "generation_sequence_copy" USING btree ("org_id","lead_id");
