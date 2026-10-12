-- Owner 2026-10-12: a channel, pipe, step, path or funnel declared through the Copilot is live the moment it is
-- created, never a draft waiting on staff publish. Every declaration still a draft goes live now.
UPDATE "declared_channels" SET "published" = true, "published_at" = now(), "published_by" = 'owner-rule-2026-10-12' WHERE "published" = false;
--> statement-breakpoint
UPDATE "declared_channel_legs" SET "published" = true WHERE "published" = false;
