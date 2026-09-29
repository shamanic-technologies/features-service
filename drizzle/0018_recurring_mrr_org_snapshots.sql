CREATE TABLE IF NOT EXISTS "recurring_mrr_org_snapshots" (
	"snapshot_date" text NOT NULL,
	"org_id" uuid NOT NULL,
	"revenue_class" text NOT NULL,
	"mrr_cents" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_mrr_org_snapshots_snapshot_date_org_id_pk" PRIMARY KEY("snapshot_date","org_id")
);
