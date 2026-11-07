-- DELETE-POST-PUBLISHED-1107 (owner 2026-11-07, « Outcome to be deleted? » then « go »): the coarse outcome
-- `post_published` leaves the catalogue. An outcome is the WHAT as fine as possible; its fine twins
-- (`threads_post_published`, `x_post_published`, `linkedin_post_published`) are live, runs-service relabelled its
-- historical occurrences, meta-service declares `threads_post_published`, and every row of campaign-service,
-- content-generation-service and billing-service naming the three Threads legs below was re-keyed to their fine twins
-- (declared 2026-11-07 through POST /internal/catalogue/pipes). Rows are RETIRED (kept, with who and why), never deleted,
-- except the step's own catalogue rows: a step nothing performs, reaches or rates any more.
--> statement-breakpoint
-- 1. The Threads workflow moves WITH its pipe: same dynasty, same state, its history appended.
INSERT INTO "workflow_leg_assignment_changes" ("feature_slug", "leg_key", "workflow_dynasty_slug", "from_state", "to_state", "decided_by", "note")
SELECT a."feature_slug", 'start_to_threads_post_published', a."workflow_dynasty_slug", NULL, a."state", 'migration-0063 (DELETE-POST-PUBLISHED-1107)', 'pipe re-keyed from threads-post|start_to_post_published: the coarse post_published outcome is retired'
FROM "workflow_leg_assignments" a
WHERE a."feature_slug" = 'threads-post' AND a."leg_key" = 'start_to_post_published'
  AND NOT EXISTS (SELECT 1 FROM "workflow_leg_assignments" b WHERE b."feature_slug" = a."feature_slug" AND b."leg_key" = 'start_to_threads_post_published' AND b."workflow_dynasty_slug" = a."workflow_dynasty_slug");
--> statement-breakpoint
UPDATE "workflow_leg_assignments" a SET "leg_key" = 'start_to_threads_post_published', "decided_by" = 'migration-0063 (DELETE-POST-PUBLISHED-1107)', "decided_at" = now()
WHERE a."feature_slug" = 'threads-post' AND a."leg_key" = 'start_to_post_published'
  AND NOT EXISTS (SELECT 1 FROM "workflow_leg_assignments" b WHERE b."feature_slug" = a."feature_slug" AND b."leg_key" = 'start_to_threads_post_published' AND b."workflow_dynasty_slug" = a."workflow_dynasty_slug");
--> statement-breakpoint
-- 2. The old pipe's stated Engine outcome: its fine twin's step IS that outcome.
DELETE FROM "pipe_engine_outcomes" WHERE "channel_slug" = 'threads-post' AND "leg_key" = 'start_to_post_published';
--> statement-breakpoint
-- 3. The three legs on the coarse step, retired (out of every catalogue read, row kept).
UPDATE "declared_channel_legs" SET "retired_at" = now(), "retired_by" = 'migration-0063 (DELETE-POST-PUBLISHED-1107)', "retire_note" = 'coarse post_published retired: re-keyed to its threads_post_published twin', "updated_at" = now()
WHERE "retired_at" IS NULL AND ("from_step" = 'post_published' OR "to_step" = 'post_published');
--> statement-breakpoint
-- 4. The declared sales funnel walking them, retired.
UPDATE "declared_sales_paths" SET "retired_at" = now(), "retired_by" = 'migration-0063 (DELETE-POST-PUBLISHED-1107)', "retire_note" = 'coarse post_published retired: its threads_post_published twin is composed by the catalogue'
WHERE "retired_at" IS NULL AND "legs"::text ~ '"legKey": "(start_to_post_published|post_published_to_[a-z_]+)"';
--> statement-breakpoint
-- 5. The step itself: its rates, its rung, its row (the twins' rates were stated with the new legs).
DELETE FROM "declared_leg_rates" WHERE "from_step" = 'post_published' OR "to_step" = 'post_published';
--> statement-breakpoint
DELETE FROM "outcome_lifecycle_rungs" WHERE "outcome_key" = 'post_published';
--> statement-breakpoint
DELETE FROM "declared_steps" WHERE "key" = 'post_published';
