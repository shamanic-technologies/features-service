-- PUBLIC FLEET INDEXES (owner 2026-10-18): one row per (index, UTC day), lib/fleet-indexes.ts.
CREATE TABLE IF NOT EXISTS "fleet_index_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"index_slug" text NOT NULL,
	"day" text NOT NULL,
	"value" double precision,
	"status" text NOT NULL,
	"outcomes" integer NOT NULL,
	"contacted" integer,
	"workflow_dynasty_slug" text,
	"workflow_dynasty_name" text,
	"unavailable_reason" text,
	"inputs" jsonb NOT NULL,
	"basis" text DEFAULT 'recorded' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_fleet_index_points_slug_day" ON "fleet_index_points" USING btree ("index_slug","day");
