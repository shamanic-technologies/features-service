/**
 * BOX HEALTH MONITOR (BOX-OVERLOAD-1026-SERIES; `lib/box-health.ts`). Service-key only (no org: a fleet fact); staff-gated
 * at api-service (READ only; the INGEST is never exposed through the gateway, the box posts in-container).
 * - `POST /internal/box-health/samples`: the box cron (every 5 min) and the one-shot sysstat backfill deliver samples.
 *   Upsert on `sampledAt` (a re-send replaces), prune > 90 days.
 * - `GET /internal/box-health?days=N`: verdict + thresholds + daily series + last 48 h + latest + top containers.
 *
 * Mounted BEFORE the global `express.json()` (100 kB default) so a backfill chunk can carry up to 2000 samples.
 */
import express, { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import {
  BoxHealthBatchSchema,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  RECENT_HOURS,
  buildBoxHealthView,
  windowStart,
} from "../lib/box-health.js";
import { readBoxHealthInputs, upsertBoxHealthSamples } from "../lib/box-health-store.js";

const router = Router();

router.post("/internal/box-health/samples", apiKeyOnly, express.json({ limit: "10mb" }), async (req, res) => {
  const parsed = BoxHealthBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const now = new Date();
  try {
    const { pruned } = await upsertBoxHealthSamples(parsed.data.samples, now);
    const times = parsed.data.samples.map((s) => Date.parse(s.sampledAt));
    res.json({
      stored: parsed.data.samples.length,
      pruned,
      oldestSampledAt: new Date(Math.min(...times)).toISOString(),
      newestSampledAt: new Date(Math.max(...times)).toISOString(),
      receivedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("[features-service] POST /internal/box-health/samples failed:", { count: parsed.data.samples.length, err });
    res.status(500).json({ error: "box_health_write_failed" });
  }
});

router.get("/internal/box-health", apiKeyOnly, async (req, res) => {
  const raw = req.query.days;
  let windowDays = DEFAULT_WINDOW_DAYS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) {
      res.status(400).json({ error: `days must be an integer between 1 and ${MAX_WINDOW_DAYS}` });
      return;
    }
    windowDays = n;
  }
  const now = new Date();
  const since = new Date(Math.min(windowStart(now, windowDays).getTime(), now.getTime() - RECENT_HOURS * 3_600_000));
  try {
    const inputs = await readBoxHealthInputs(since, now);
    res.json(buildBoxHealthView(inputs, now, windowDays));
  } catch (err) {
    console.error("[features-service] GET /internal/box-health failed:", err);
    res.status(500).json({ error: "box_health_unreadable" });
  }
});

export default router;
