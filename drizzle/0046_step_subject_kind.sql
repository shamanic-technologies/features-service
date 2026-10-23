-- COST-ACCOUNTING-1023 (owner 2026-10-23): every outcome states what one occurrence is about, a person or an object
-- (`lib/outcome-subject.ts`): the one per-outcome fact the cost ledger needs. Null = a declared step that never stated it.
ALTER TABLE "declared_steps" ADD COLUMN IF NOT EXISTS "subject_kind" text;
