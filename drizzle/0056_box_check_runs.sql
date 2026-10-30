-- BOX-WATCHDOGS-1030: one generic registry of the production box's watchdog runs (deploy pipeline, service health, workflow
-- queue, Jev chain, own-org balance, any future check), one row per (check name, run instant), re-send replaces. Additive.
CREATE TABLE IF NOT EXISTS "box_check_runs" (
	"check_name" text NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"ok" boolean NOT NULL,
	"reason" text,
	"cadence_minutes" integer NOT NULL,
	"label" text,
	"value" double precision,
	"unit" text,
	"details" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_check_runs_check_name_ran_at_pk" PRIMARY KEY("check_name","ran_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_box_check_runs_ran_at" ON "box_check_runs" USING btree ("ran_at");
