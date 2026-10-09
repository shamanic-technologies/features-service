ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'event' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "params" jsonb;--> statement-breakpoint
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
ALTER TABLE "channel_trigger_types" ADD COLUMN IF NOT EXISTS "requested_by_org_id" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "declared_channels" (
	"slug" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"short_description" text NOT NULL,
	"icon" text NOT NULL,
	"channel_type" text NOT NULL,
	"operated_by" text NOT NULL,
	"performed_by" text NOT NULL,
	"daily_operating_cost_cents" integer NOT NULL,
	"minimum_commitment_days" integer NOT NULL,
	"max_days_to_first_production" integer NOT NULL,
	"display_order" integer NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_by" text NOT NULL,
	"requested_by_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "declared_channels_name_unique" UNIQUE("name")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "declared_channel_legs" (
	"channel_slug" text NOT NULL,
	"leg_key" text NOT NULL,
	"from_step" text,
	"to_step" text NOT NULL,
	"mode" text NOT NULL,
	"trigger_id" text,
	"published" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"requested_by_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "declared_channel_legs_channel_slug_leg_key_pk" PRIMARY KEY("channel_slug","leg_key")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "declared_sales_paths" (
	"combination_key" text PRIMARY KEY NOT NULL,
	"legs" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"requested_by_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
