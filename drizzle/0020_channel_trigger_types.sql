CREATE TABLE IF NOT EXISTS "channel_trigger_types" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"from_step" text,
	"fired_by" text NOT NULL,
	"coded" boolean NOT NULL,
	"display_order" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
