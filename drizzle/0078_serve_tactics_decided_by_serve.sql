-- REPLY-NO-SCRIPT-1119 (prod 2026-11-19, Doc Dinners): « Lead follow-up due » is about WHO a find script is handed (its
-- lead.serve call, tactics field `serve`), yet it narrowed Message sent too, where no script states `serve`: it kept no
-- answering script, so every reply on two campaigns went unanswered (drkaylynne, Nov 11). A serve tactic narrows only the
-- Engines whose scripts state `serve` (Lead found, Email sent), the way migration 0075 scoped who-is-answered tactics.
UPDATE "tactics" SET "decided_by_fields" = ARRAY['serve'] WHERE "id" IN ('script-business-contacts-only', 'script-catch-all-emails', 'script-contacted-pure-prospects', 'script-email-reach', 'script-fresh-contacts-2-months', 'script-fresh-contacts-3-months', 'script-fresh-contacts-never-emailed', 'script-lead-follow-up-due', 'script-phone-reach', 'script-unknown-emails', 'script-warm-never-converted') AND "decided_by_fields" IS NULL;
