/**
 * GET /brands/:brandId/rate-sources (SCRIPT-VALUE-RATING-1113-RATES, owner 2026-11-13; rule `lib/rate-sources.ts`).
 * Per leg the client can state (brand-service's leg list, its own step words): whether the brand's ledger MEASURES it (the
 * script Rating's rule), the measured rate and counts, else `ask: true` with the default to prefill; and the rate in force
 * with its source (measured | stated | default). The Brand page and the onboarding ask only the `ask: true` legs.
 * Additive: nothing here moves a price, a campaign or an expected return. Org-scoped; Gold cell keyed on what the client
 * stated, so a just-typed rate is never replayed old.
 */
import { createHash } from "node:crypto";
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { fetchBrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { getMeetingReporting } from "../lib/meeting-reporting-client.js";
import { legRateSources, type LegRateSource } from "../lib/rate-sources.js";
import { MIN_CONSUMED_UNITS } from "../lib/script-value-rating.js";
import { readStepRateBook } from "../lib/script-value-rating-io.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";
import { buildScopeKey, sendSnapshotJson, servedCachedJson } from "../lib/view-cache.js";

const router = Router();

export interface RateSourcesBody {
  brandId: string;
  /** When runs-service built the outcome chains the measured rates read. */
  builtAt: string;
  /** The bar a step must pass: consumed Units of its start (and at least one led to its end). */
  minConsumedUnits: number;
  reportsMeetings: boolean;
  legs: LegRateSource[];
}

router.get("/brands/:brandId/rate-sources", apiKeyAuth, async (req, res) => {
  const auth = req as unknown as AuthenticatedRequest & { params: { brandId: string } };
  const brandId = auth.params.brandId;
  try {
    await assertBrandHeld(brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId });
    const statements = await fetchBrandLegEconomics(brandId, auth.orgId);
    const stated = createHash("sha256")
      .update(JSON.stringify(statements.legRates.map((l) => [l.fromStep, l.toStep, l.stated, l.ratePct])))
      .digest("hex")
      .slice(0, 16);
    const payload = await servedCachedJson<RateSourcesBody>({
      view: "brand-rate-sources",
      responseShape: routeResponseShapeFingerprint("/brands/{brandId}/rate-sources"),
      scopeKey: buildScopeKey(brandId, { orgId: auth.orgId, stated }),
      orgId: auth.orgId,
      compute: async () => {
        const [brand, fleet, reporting] = await Promise.all([readStepRateBook(brandId), readStepRateBook(null), getMeetingReporting()]);
        const reportsMeetings = reporting.reports(brandId);
        return {
          brandId,
          builtAt: brand.builtAt,
          minConsumedUnits: MIN_CONSUMED_UNITS,
          reportsMeetings,
          legs: legRateSources({ legs: statements.legRates, brand, fleet, reportsMeetings }),
        };
      },
    });
    sendSnapshotJson(res, payload);
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error(`[features-service] rate sources for brand ${brandId}:`, err);
    res.status(502).json({ error: (err as Error).message, reason: "rate_sources_unreadable" });
  }
});

export default router;
