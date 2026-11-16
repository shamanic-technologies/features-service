-- ONE-WRITER-N-MODELS-1116-LEADS-ONLY (owner 2026-11-16): a script tactic states the script tactics fields it is about;
-- a strategy naming it narrows an Engine's scripts only where one of them states such a field (that Engine decides it).
ALTER TABLE "tactics" ADD COLUMN IF NOT EXISTS "decided_by_fields" text[];
--> statement-breakpoint
-- Who a script answers is decided by the script that CLAIMS the person (tactics field `relationships`, stated by every
-- claiming script: Message sent, Paid client, meetings), never by a writer its sender asks (Message written states none).
UPDATE "tactics" SET "decided_by_fields" = ARRAY['relationships'] WHERE "id" IN ('script-answers-leads-only', 'script-current-clients-only', 'script-answers-the-brand-s-team-only') AND "decided_by_fields" IS NULL;
