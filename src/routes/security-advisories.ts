/**
 * SECURITY ADVISORIES MONITOR (SEC-ADVISORIES-SERIES-1025; `lib/security-advisories.ts`). Service-key only (no org: a
 * fleet fact); staff-gated at api-service.
 * - `POST /internal/security-advisories/reports`: the owner's daily audit job delivers one day's report (every prod repo).
 *   Re-sending a day replaces it.
 * - `GET /internal/security-advisories?days=N`: the last N UTC days per repo + the served red/green verdict.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  SecurityAdvisoryReportSchema,
  buildSecurityAdvisoriesView,
  utcDayOf,
  windowDaysEnding,
} from "../lib/security-advisories.js";
import { readSecurityAdvisoryRows, replaceSecurityAdvisoryDay } from "../lib/security-advisories-store.js";

const router = Router();

router.post("/internal/security-advisories/reports", apiKeyOnly, async (req, res) => {
  const parsed = SecurityAdvisoryReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const now = new Date();
  const day = parsed.data.day ?? utcDayOf(now);
  try {
    await replaceSecurityAdvisoryDay(day, parsed.data.repos, now);
    res.json({ day, repoCount: parsed.data.repos.length, reportedAt: now.toISOString() });
  } catch (err) {
    console.error("[features-service] POST /internal/security-advisories/reports failed:", { day, err });
    res.status(500).json({ error: "security_advisories_write_failed" });
  }
});

router.get("/internal/security-advisories", apiKeyOnly, async (req, res) => {
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
  try {
    const rows = await readSecurityAdvisoryRows(windowDaysEnding(now, windowDays)[0]);
    res.json(buildSecurityAdvisoriesView(rows, now, windowDays));
  } catch (err) {
    console.error("[features-service] GET /internal/security-advisories failed:", err);
    res.status(500).json({ error: "security_advisories_unreadable" });
  }
});

export default router;
