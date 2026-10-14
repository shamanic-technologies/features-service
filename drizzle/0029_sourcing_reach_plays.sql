-- LEAK-1012 (owner 2026-10-14): a source pipe offers LEAD STRATEGIES saying who it finds. Two funnels of one offer on
-- the same source pick different plays, so neither takes the other's people. The "who" is stated by the WORKFLOW in
-- its lead-service serve call (`reachableBy`), judged by Jev per version on these tactics. Generic for every sourcing
-- pipe; only CRM contacts catalogues the plays now. Its DEFAULT play (the generic workflow, which states no reach) is
-- set by staff through PUT /internal/catalogue/pipes/:pipeId/default-play once Jev has judged that workflow on these
-- tactics (the route refuses a default that would run nothing).
INSERT INTO "tactics" ("id", "name", "description", "created_by") VALUES
  ('phone-reach', 'Phone reach', 'The workflow''s lead serve calls lead-service POST /orgs/buffer/next with the body field reachableBy listing "phone", so it never hands out a person without a phone number. A serve call that omits reachableBy or does not list "phone" does not follow this tactic.', 'owner-2026-10-14'),
  ('email-reach', 'Email reach', 'The workflow''s lead serve calls lead-service POST /orgs/buffer/next with the body field reachableBy listing "email", so it never hands out a person without an email address. A serve call that omits reachableBy or does not list "email" does not follow this tactic.', 'owner-2026-10-14')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "strategies" ("id", "name", "description", "requires_tactic_ids", "excludes_tactic_ids", "created_by") VALUES
  ('reachable-by-phone', 'Reachable by phone', 'People reachable on WhatsApp or by phone (they have a phone number).', '{phone-reach}', '{}', 'owner-2026-10-14'),
  ('reachable-by-email', 'Reachable by email', 'People reachable by email (they have an email address).', '{email-reach}', '{}', 'owner-2026-10-14')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plays" ("pipe_id", "strategy_id", "is_default", "created_by") VALUES
  ('sourcing-crm-contacts|start_to_lead_found', 'reachable-by-phone', false, 'owner-2026-10-14'),
  ('sourcing-crm-contacts|start_to_lead_found', 'reachable-by-email', false, 'owner-2026-10-14')
ON CONFLICT DO NOTHING;
