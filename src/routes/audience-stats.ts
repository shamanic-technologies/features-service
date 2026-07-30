import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { computeAudienceStats, type ComputeResult } from "../lib/audience-stats-compute.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";

const router = Router();

router.get("/features/:featureSlug/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const { featureSlug } = req.params;
    const { orgId, userId, runId } = req as AuthenticatedRequest;

    // GROSS (default) vs NET pricing. Omitted → gross → byte-identical to today.
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) {
      return res.status(400).json({ error: "pricing must be one of: gross, net" });
    }
    // NET reads runs#179's frozen net cost fields (no billing call, no read-time multiply); GROSS is
    // byte-identical. The selector is threaded into computeAudienceStats' cost read below. A NET request
    // where the net figure is absent throws inside computeAudienceStats → 502 (never cached, no fallback).

    // The derived cost columns (cost per form submission / signup / sale) project through the brand's
    // economics via `fetchBrandProjectedParents`, so the body goes stale the moment the economics change.
    // Fold their fingerprint into the cache key: an economics write lands on a different cell and forces a
    // fresh compute, instead of replaying a pre-write snapshot until the hard-stale cap. Read here for the
    // KEY only; the compute does its own read on a miss (one extra brand-service call on the miss path,
    // which is not worth threading an override through computeAudienceStats → fetchBrandProjectedParents).
    //
    // FAIL-SOFT, and deliberately so: this read feeds a CACHE KEY, not the response, so it must not change
    // the endpoint's HTTP semantics. This route's parameter validation lives INSIDE computeAudienceStats
    // (see CLAUDE.md), i.e. AFTER this point — so a hard failure here would turn an invalid-parameter 400
    // into a 502. Degrading to "no fingerprint in the key" keeps all three outcomes correct: an invalid
    // request still 400s from the compute; a genuinely unreachable brand-service still 502s, because the
    // compute's own economics read fails loud; and the nominal path still gets the fingerprint.
    // NB the fetch is wrapped in an async IIFE, not a trailing `.catch()`: `fetchEffectiveEconomics`
    // validates its env (BRAND_SERVICE_URL / API_KEY) and throws SYNCHRONOUSLY before its first await, and
    // a synchronous throw escapes a `.catch()` chained onto the call — it never becomes a rejected
    // promise. That is precisely how this slipped through locally (env present, so no sync throw) and
    // turned two 400-assertion tests into 502s in CI (env absent).
    const brandId = req.query.brandId as string | undefined;
    const econ = await (async () => {
      if (!brandId) return undefined;
      try {
        return economicsFingerprint(await fetchEffectiveEconomics(brandId, { orgId, userId, runId, featureSlug }));
      } catch (err) {
        console.warn(
          `[features-service] audience-stats economics fingerprint unavailable (keying without it): ${(err as Error).message}`,
        );
        return undefined;
      }
    })();

    // Gold SWR: the cost + membership + email fan-out runs off the request path ~once per TTL, keyed on
    // every input that shapes the body. The ComputeResult is deterministic (validation 400/404 or a
    // ranked envelope) so it is safe to cache; transient downstream failures THROW inside
    // computeAudienceStats and propagate to the catch below (a 502, never cached).
    const scopeKey = buildScopeKey(featureSlug, {
      orgId,
      brandId: req.query.brandId,
      goal: req.query.goal,
      statuses: req.query.statuses,
      limit: req.query.limit,
      brandProfileId: req.query.brandProfileId,
      pricing,
      econ,
      // Campaign scope is part of the cache key so campaign-scoped and brand-wide snapshots never
      // collide. Absent → dropped by buildScopeKey → key byte-identical to the brand-wide request.
      campaignId: req.query.campaignId,
    });
    const result = await servedCached<ComputeResult>({
      view: "audience-stats",
      scopeKey,
      orgId,
      compute: () => computeAudienceStats(req, pricing),
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result.envelope);
  } catch (error) {
    console.error("[features-service] Audience stats error:", error);
    res.status(502).json({ error: "Failed to compute audience stats" });
  }
});

export default router;
