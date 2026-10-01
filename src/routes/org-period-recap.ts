/**
 * GET /internal/orgs/:orgId/period-recap?from=YYYY-MM-DD&to=YYYY-MM-DD — one org's outbound over a window
 * and what it is expected to return. Consumer: billing-service, from a scheduler, when a subscription month's
 * credit is used up (no end user in context: api-key only, org in the PATH). Every rule is in
 * `lib/org-period-recap.ts`. Validation answers 400 before any read; a producer failure is a 502, never a
 * guessed figure.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import {
  MAX_WINDOW_DAYS,
  computeOrgPeriodRecap,
  defaultRecapDeps,
  isCalendarDay,
  windowDays,
  type RecapDeps,
} from "../lib/org-period-recap.js";
import { fleetPositiveReplyRateFromOutcomePrices } from "./public.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let deps: RecapDeps = defaultRecapDeps(fleetPositiveReplyRateFromOutcomePrices);

/** Test seam. */
export function __setRecapDepsForTest(next: Partial<RecapDeps> | null): void {
  deps = next ? { ...defaultRecapDeps(fleetPositiveReplyRateFromOutcomePrices), ...next } : defaultRecapDeps(fleetPositiveReplyRateFromOutcomePrices);
}

const router = Router();

router.get("/internal/orgs/:orgId/period-recap", apiKeyOnly, async (req, res) => {
  const orgId = String(req.params.orgId);
  const { from, to } = req.query;
  if (!UUID_RE.test(orgId)) return res.status(400).json({ error: "orgId must be a UUID", code: "org_id_invalid" });
  if (!isCalendarDay(from) || !isCalendarDay(to)) {
    return res.status(400).json({ error: "from and to are required calendar days (YYYY-MM-DD, UTC, inclusive)", code: "window_invalid" });
  }
  if (to < from) return res.status(400).json({ error: "to must not be before from", code: "window_invalid" });
  if (windowDays(from, to).length > MAX_WINDOW_DAYS) {
    return res.status(400).json({ error: `window must span at most ${MAX_WINDOW_DAYS} days`, code: "window_too_long" });
  }
  try {
    return res.json(await computeOrgPeriodRecap(orgId, from, to, deps));
  } catch (error) {
    console.error(`[features-service] period-recap failed for org ${orgId} ${from}..${to}:`, error);
    return res.status(502).json({ error: "Failed to compute the period recap" });
  }
});

export default router;
