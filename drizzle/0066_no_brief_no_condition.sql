-- NO-BRIEF-UNBLOCK-1111 (owner 2026-11-11: « Une stratégie est un booléen de tactics. Des tactics sont des filtres sur
-- des scripts. Le choix du script est censé être fait automatiquement par le best ROI »). A campaign stating no brief
-- keeps NO condition on every Engine: every runnable script, the Rating picks. The per-Engine default strategy of
-- migration 0065 is deleted: verdicts it wrote become "no condition" (source `empty_brief`), the column goes.
UPDATE "campaign_engine_strategies" SET "strategy_id" = NULL, "source" = 'empty_brief' WHERE "source" = 'engine_default';
--> statement-breakpoint
ALTER TABLE "strategies" DROP COLUMN IF EXISTS "default_for_outcomes";
