-- Every trigger has a unique NAME (owner 2026-10-11): a reactive sales path or funnel starts with its trigger, shown by
-- name. The slug (`id`) is already the primary key.
CREATE UNIQUE INDEX IF NOT EXISTS "channel_trigger_types_label_lower_unique" ON "channel_trigger_types" (lower("label"));
