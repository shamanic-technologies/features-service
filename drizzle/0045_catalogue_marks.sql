-- MARKS-1022 (owner 2026-10-22, « chaque template ait son icône »): every workflow dynasty and every template dynasty
-- gets its own icon + colour, written once on first sight and never moved (`lib/catalogue-marks.ts`).
CREATE TABLE IF NOT EXISTS "catalogue_marks" (
  "family" text NOT NULL,
  "object_key" text NOT NULL,
  "icon" text NOT NULL,
  "color" text NOT NULL,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "catalogue_marks_pk" PRIMARY KEY ("family", "object_key"),
  CONSTRAINT "catalogue_marks_family_mark_unique" UNIQUE ("family", "icon", "color")
);
