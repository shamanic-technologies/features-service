-- MON-PLAN-FOLLOWING-1122: the pipe judge also asks whether the brief NAMES the channel as one to use; null = a verdict
-- stored before (re-asked: the judge's rule moved to v6).
ALTER TABLE "factory_pipe_verdicts" ADD COLUMN IF NOT EXISTS "named_probability" double precision;
