/**
 * BOX CHECKS (BOX-WATCHDOGS-1030; `lib/box-checks.ts`). ONE generic registry for the production box's watchdog scripts,
 * keyed by a check name the caller sends (never a route per check). Service-key only (no org: a fleet fact); staff-gated at
 * api-service (READ only; the INGEST is never exposed through the gateway, the box posts in-container on localhost).
 * - `POST /internal/box-checks/runs`: every watchdog run posts its result. Upsert on (check, ranAt), prune > 90 days.
 * - `GET /internal/box-checks?days=N&expect=a,b`: per check, verdict + plain-words reason + last run + daily and 48 h series.
 * No alerting from the service: red on the hub is the alert.
 *
 * Mounted BEFORE the global `express.json()` (100 kB default) with its own 2 MB limit (500 runs x details).
 */
import express, { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import {
  BoxCheckBatchSchema,
  CHECK_NAME_PATTERN,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  RECENT_HOURS,
  buildBoxChecksView,
  windowStart,
} from "../lib/box-checks.js";
import { readBoxChecksInputs, upsertBoxCheckRuns } from "../lib/box-checks-store.js";

const router = Router();

router.post("/internal/box-checks/runs", apiKeyOnly, express.json({ limit: "2mb" }), async (req, res) => {
  const parsed = BoxCheckBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const now = new Date();
  try {
    const { pruned } = await upsertBoxCheckRuns(parsed.data.runs, now);
    res.json({
      stored: parsed.data.runs.length,
      pruned,
      checks: [...new Set(parsed.data.runs.map((r) => r.check))].sort(),
      receivedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("[features-service] POST /internal/box-checks/runs failed:", { count: parsed.data.runs.length, err });
    res.status(500).json({ error: "box_checks_write_failed" });
  }
});

router.get("/internal/box-checks", apiKeyOnly, async (req, res) => {
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
  let expected: string[] = [];
  const rawExpect = req.query.expect;
  if (rawExpect !== undefined) {
    if (typeof rawExpect !== "string") {
      res.status(400).json({ error: "expect must be a comma-separated list of check names" });
      return;
    }
    expected = rawExpect.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const bad = expected.find((s) => !CHECK_NAME_PATTERN.test(s));
    if (bad !== undefined) {
      res.status(400).json({ error: `expect: invalid check name "${bad}"` });
      return;
    }
  }
  const now = new Date();
  const since = new Date(Math.min(windowStart(now, windowDays).getTime(), now.getTime() - RECENT_HOURS * 3_600_000));
  try {
    const inputs = await readBoxChecksInputs(since);
    res.json(buildBoxChecksView(inputs, now, windowDays, expected));
  } catch (err) {
    console.error("[features-service] GET /internal/box-checks failed:", err);
    res.status(500).json({ error: "box_checks_unreadable" });
  }
});

export default router;
