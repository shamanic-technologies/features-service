CREATE TABLE IF NOT EXISTS "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"audience_type" text NOT NULL,
	"implemented" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"signature" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"workflow_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result_component" text,
	"default_workflow_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "features_slug_unique" UNIQUE("slug"),
	CONSTRAINT "features_name_unique" UNIQUE("name"),
	CONSTRAINT "features_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_features_slug" ON "features" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_features_signature" ON "features" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_features_name" ON "features" USING btree ("name");