CREATE TABLE IF NOT EXISTS "sales_path_combination_names" (
	"combination_key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_path_combination_names_name_unique" UNIQUE("name")
);
