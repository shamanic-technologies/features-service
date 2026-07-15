CREATE TABLE IF NOT EXISTS "committed_mrr_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_date" text NOT NULL,
	"committed_daily_budget_cents" integer NOT NULL,
	"active_count" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_committed_mrr_snapshots_date" ON "committed_mrr_snapshots" USING btree ("snapshot_date");