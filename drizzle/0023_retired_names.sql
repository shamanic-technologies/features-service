CREATE TABLE IF NOT EXISTS "retired_names" (
	"name" text PRIMARY KEY NOT NULL,
	"combination_key" text NOT NULL,
	"replaced_by" text NOT NULL,
	"reason" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
