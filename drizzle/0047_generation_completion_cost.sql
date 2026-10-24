-- MODEL-RUN-COST-1024: what ONE writing run of a model costs on a pipe (Research > Models). Per copied sequence: the run
-- content-generation-service states WROTE it (the chat completion), its recorded token counts, and that run's own LLM
-- cost as runs-service charged it (billed gross, committed), split input (cache folded in) vs output tokens.
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "completion_run_ids" text[];
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "completion_unknown_reason" text;
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "tokens_input" integer;
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "tokens_output" integer;
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "llm_input_cost_cents" numeric;
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "llm_output_cost_cents" numeric;
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "llm_cost_status" text;
--> statement-breakpoint
ALTER TABLE "generation_sequence_copy" ADD COLUMN IF NOT EXISTS "llm_cost_read_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_generation_sequence_copy_cost_due" ON "generation_sequence_copy" USING btree ("llm_cost_read_at") WHERE "completion_run_ids" IS NOT NULL;
