-- BOX-DISK-1101: root filesystem size / free per box health sample, MB. Nullable: older samples and the sysstat backfill
-- carry no disk (unknown, never red). Additive.
ALTER TABLE "box_health_samples" ADD COLUMN IF NOT EXISTS "disk_total_mb" double precision;--> statement-breakpoint
ALTER TABLE "box_health_samples" ADD COLUMN IF NOT EXISTS "disk_available_mb" double precision;
