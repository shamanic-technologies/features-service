CREATE TABLE IF NOT EXISTS "declared_steps" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL UNIQUE,
	"description" text NOT NULL,
	"short_description" text NOT NULL,
	"icon" text NOT NULL,
	"toward_step" text NOT NULL,
	"toward_rate_pct" double precision NOT NULL,
	"produced_by" text,
	"created_by" text NOT NULL,
	"requested_by_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "declared_leg_rates" (
	"from_step" text NOT NULL,
	"to_step" text NOT NULL,
	"rate_pct" double precision NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "declared_leg_rates_pk" PRIMARY KEY ("from_step", "to_step")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "declared_sales_path_chains" (
	"path_id" text PRIMARY KEY NOT NULL,
	"leg_keys" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"requested_by_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
