CREATE TABLE IF NOT EXISTS "stated_monthly_amounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"start_date" text,
	"end_date" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_stated_monthly_amounts_pair" ON "stated_monthly_amounts" USING btree ("org_id","brand_id");
