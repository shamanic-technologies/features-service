import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { computeAudienceStats, validateAudienceStatsQuery, type ComputeResult } from "../lib/audience-stats-compute.js";
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

    // Validate FIRST — the economics read below is a NETWORK call, and it must never run for a request
    // that is going to 400 anyway. With an unreachable brand-service the retrying client burns seconds
    // before failing, which is a hang, not just wasted work (it turned two validation tests into 5s
    // timeouts in CI while they passed locally). Shares ONE definition of "valid" with
    // computeAudienceStats, which calls the same validator, so the route cannot drift from the lib.
    const validated = validateAudienceStatsQuery(req);
    if (!validated.ok) {
      return res.status(validated.status).json({ error: validated.error });
    }

    // The derived cost columns (cost per form submission / signup / sale) project through the brand's
    // economics via `fetchBrandProjectedParents`, so the body goes stale the moment the economics change.
    // Folding the fingerprint into the cache key makes an economics write land on a different cell, which
    // forces a fresh compute instead of replaying a pre-write snapshot until the hard-stale cap. Read here
    // for the KEY only; the compute does its own read on a miss (one extra brand-service call on the miss
    // path, not worth threading an override down through fetchBrandProjectedParents).
    //
    // Fail-soft, via a real try/catch rather than a trailing `.catch()`: `fetchEffectiveEconomics`
    // validates its env and can throw SYNCHRONOUSLY before its first await, which a chained `.catch()`
    // would not see. This read feeds a cache KEY, not the response, so its failure must not change the
    // endpoint's HTTP semantics — degrade to "no fingerprint in the key" and let the compute (which reads
    // economics fail-loud) decide the status.
    let econ: string | undefined;
    try {
      econ = economicsFingerprint(
        await fetchEffectiveEconomics(validated.brandId, { orgId, userId, runId, featureSlug }),
      );
    } catch (err) {
      console.warn(
        `[features-service] audience-stats economics fingerprint unavailable (keying without it): ${(err as Error).message}`,
      );
    }

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
