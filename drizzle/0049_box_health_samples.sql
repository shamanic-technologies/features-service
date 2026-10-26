-- BOX-OVERLOAD-1026-SERIES: samples of the production Hetzner box (load, memory, swap, OOM kills, per-container usage),
-- one row per sample instant (re-send replaces). Posted by the box cron every 5 minutes; read by the staff Monitoring hub.
CREATE TABLE IF NOT EXISTS "box_health_samples" (
	"sampled_at" timestamp with time zone PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"load1" double precision NOT NULL,
	"load5" double precision NOT NULL,
	"load15" double precision NOT NULL,
	"cores" integer NOT NULL,
	"mem_total_mb" double precision NOT NULL,
	"mem_available_mb" double precision NOT NULL,
	"swap_total_mb" double precision NOT NULL,
	"swap_used_mb" double precision NOT NULL,
	"oom_kills" integer,
	"containers" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
