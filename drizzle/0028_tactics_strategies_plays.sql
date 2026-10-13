-- Tactics, strategies and plays (owner 2026-10-13). A TACTIC is a yes/no tag on a workflow version, judged by Jev
-- against its description and stored per version. A STRATEGY requires and excludes tactics. A PLAY is a pipe x a
-- strategy, catalogued per pipe; a pipe's default play is what its campaigns run when their sales funnel names no
-- strategy. Names AND descriptions are unique (case-insensitive) in both families.
CREATE TABLE IF NOT EXISTS "tactics" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tactics_name_lower_unique" ON "tactics" (lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tactics_description_lower_unique" ON "tactics" (lower("description"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategies" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "requires_tactic_ids" text[] DEFAULT '{}' NOT NULL,
  "excludes_tactic_ids" text[] DEFAULT '{}' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_name_lower_unique" ON "strategies" (lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_description_lower_unique" ON "strategies" (lower("description"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plays" (
  "pipe_id" text NOT NULL,
  "strategy_id" text NOT NULL REFERENCES "strategies"("id"),
  "is_default" boolean DEFAULT false NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("pipe_id", "strategy_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plays_one_default_per_pipe" ON "plays" ("pipe_id") WHERE "is_default";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_tactic_verdicts" (
  "workflow_slug" text NOT NULL,
  "tactic_id" text NOT NULL REFERENCES "tactics"("id"),
  "workflow_dynasty_slug" text NOT NULL,
  "feature_slug" text NOT NULL,
  "version" integer NOT NULL,
  "version_active" boolean NOT NULL,
  "verdict" boolean NOT NULL,
  "probability" double precision NOT NULL,
  "model" text NOT NULL,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("workflow_slug", "tactic_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_tactic_verdicts_dynasty" ON "workflow_tactic_verdicts" ("workflow_dynasty_slug");
--> statement-breakpoint
INSERT INTO "tactics" ("id", "name", "description", "created_by") VALUES
  ('catch-all', 'Catch-all', 'Sends to addresses whose mail server accepts every address, so the mailbox cannot be confirmed.', 'owner-2026-10-13')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "strategies" ("id", "name", "description", "requires_tactic_ids", "excludes_tactic_ids", "created_by") VALUES
  ('valid-only', 'Valid only', 'Sends only to addresses whose mailbox is confirmed, never to a catch-all address.', '{}', '{catch-all}', 'owner-2026-10-13'),
  ('valid-catch-all', 'Valid + Catch-all', 'Sends to confirmed addresses and also to catch-all addresses, whose mailbox cannot be confirmed.', '{catch-all}', '{}', 'owner-2026-10-13')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "plays" ("pipe_id", "strategy_id", "is_default", "created_by") VALUES
  ('sales-cold-email-outreach|lead_found_to_conversation', 'valid-only', true, 'owner-2026-10-13'),
  ('sales-cold-email-outreach|lead_found_to_conversation', 'valid-catch-all', false, 'owner-2026-10-13')
ON CONFLICT DO NOTHING;
