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
  type OfferReturnRead,
  type OutcomeSeries,
  type RecapDeps,
} from "../lib/org-period-recap.js";
import { DEFAULT_PRICED_CAUSES } from "../lib/outcome-cause.js";
import { OfferHasNoChannelsError } from "../lib/offer-channels.js";
import { fleetPositiveReplyRateFromOutcomePrices } from "./public.js";
import { offerRevenueJson } from "./offer-economics.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A served `{total, daily, undatedCount}` series, or null when the body does not carry a well-formed one. */
function outcomeSeriesOf(v: unknown): OutcomeSeries | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { total?: unknown; daily?: unknown; undatedCount?: unknown };
  const total = num(s.total);
  const undatedCount = num(s.undatedCount);
  if (total === null || undatedCount === null || !Array.isArray(s.daily)) return null;
  const daily: OutcomeSeries["daily"] = [];
  for (const d of s.daily as Array<{ date?: unknown; count?: unknown }>) {
    const count = num(d?.count);
    if (typeof d?.date !== "string" || count === null) return null;
    daily.push({ date: d.date, count });
  }
  return { total, daily, undatedCount };
}

/**
 * The offer's return EXACTLY as the dashboard's Today page reads it: `/offers/:offerId/revenue?brandId=&pricing=net`
 * with every other parameter at its default, through the route's own `offerRevenueJson` (same Gold cell,
 * keyed on the org, never the user). null = the offer has no campaign, so no page shows it a return.
 */
export async function readOfferReturn(orgId: string, brandId: string, offerId: string): Promise<OfferReturnRead | null> {
  let json: string;
  try {
    json = (
      await offerRevenueJson({
        offerId,
        brandId,
        pricing: "net",
        identity: { orgId },
        leadDetail: "outcomes",
        causes: DEFAULT_PRICED_CAUSES,
        windowDays: undefined,
      })
    ).json;
  } catch (error) {
    if (error instanceof OfferHasNoChannelsError) return null;
    throw error;
  }
  const body = JSON.parse(json) as {
    headline?: { totalPipelineUsd?: unknown };
    costEconomics?: { committedCostUsd?: unknown; maturity?: OfferReturnRead["pair"] };
    recipientsRepliesPositive?: unknown;
    meetingsBooked?: unknown;
  };
  if (!body.costEconomics) throw new Error(`offer ${offerId} revenue body carries no costEconomics`);
  return {
    offerId,
    pair: body.costEconomics.maturity ?? null,
    pipelineUsd: num(body.headline?.totalPipelineUsd),
    committedCostUsd: num(body.costEconomics.committedCostUsd),
    // The SAME dated series the dashboard draws, from the same body: never recounted here.
    outcomeSeries: {
      positiveReplies: outcomeSeriesOf(body.recipientsRepliesPositive),
      meetingsBooked: outcomeSeriesOf(body.meetingsBooked),
    },
  };
}

const defaults = () => defaultRecapDeps(fleetPositiveReplyRateFromOutcomePrices, readOfferReturn);
let deps: RecapDeps = defaults();

/** Test seam. */
export function __setRecapDepsForTest(next: Partial<RecapDeps> | null): void {
  deps = next ? { ...defaults(), ...next } : defaults();
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
