-- DEFAULT-PLAY-AND-TACTIC-EDIT-PUBLIC-1014 (owner 2026-10-14): a tactic's description can be EDITED, and every
-- workflow version is re-judged on the new words. Each verdict records the description it was judged on, so the sweep
-- re-asks Jev exactly the rows judged on an older text, and the old verdict keeps serving until its replacement lands
-- (a strategy never sees an unjudged workflow mid-edit). Every stored verdict was judged on the description its tactic
-- holds today: no description was ever edited before this migration.
ALTER TABLE "tactics" ADD COLUMN IF NOT EXISTS "updated_by" text;
--> statement-breakpoint
ALTER TABLE "tactics" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_tactic_verdicts" ADD COLUMN IF NOT EXISTS "judged_description" text;
--> statement-breakpoint
UPDATE "workflow_tactic_verdicts" v SET "judged_description" = t."description" FROM "tactics" t WHERE t."id" = v."tactic_id" AND v."judged_description" IS NULL;
--> statement-breakpoint
ALTER TABLE "workflow_tactic_verdicts" ALTER COLUMN "judged_description" SET NOT NULL;
