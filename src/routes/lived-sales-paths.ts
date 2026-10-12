/**
 * `GET /brands/:brandId/lived-sales-paths[?offerId=&pricing=]`: the LIVED sales paths (`lib/lived-sales-paths.ts`, pure). One brand (optionally one offer), since
 * inception: the people's journeys from lead-service's timeline, each campaign's COMMITTED spend from runs
 * (the brand's channel set, the same spend the brand's `/revenue` reads), the sales funnel campaign of each
 * unit from campaign-service, the offers' lifetime revenue from brand-service (stated, else the fleet
 * median), and the catalogue's step keys + expected path economics. Every read is fail-loud except the
 * catalogue's EXPECTED figures (named reason; the lived figures never wait on the fleet build).
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { parsePricing } from "../lib/pricing.js";
import { buildScopeKey, servedCachedJson, sendSnapshotJson } from "../lib/view-cache.js";
import { BrandOwnershipError, assertBrandHeld } from "../lib/brand-ownership.js";
import { fetchBrandJourneys } from "../lib/brand-journeys-client.js";
import { fetchRunsCostUsdByCampaign } from "../lib/runs-cost-client.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import { fetchBrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { resolveBrandChannels, brandFeatureSlugs, BrandHasNoChannelsError } from "../lib/brand-channels.js";
import { computeLivedPaths, type FunnelCampaignRef, type LivedPathRow, type LivedPathsResult, type LivedTotals, type LivedFunnelGroup } from "../lib/lived-sales-paths.js";
import type { Pricing } from "../lib/pricing.js";
import { catalogueForLivedPaths, type ExpectedPathFigures } from "./agent-catalogue.js";

export type ExpectedPathRef = ExpectedPathFigures;

export type ServedLivedPath = LivedPathRow & { expected: ExpectedPathRef | null };

export interface LivedSalesPathsBody {
  brandId: string;
  offerId: string | null;
  costBasis: "charged";
  pricing: Pricing;
  /** Always `inception`: a lived path is read over every person ever reached, never a window. */
  since: "inception";
  totals: LivedTotals;
  paths: ServedLivedPath[];
  funnels: Array<Omit<LivedFunnelGroup, "paths"> & { paths: ServedLivedPath[] }>;
  /** Why `expected` is null on every row (the catalogue economics could not be read); null when served. */
  expectedUnavailableReason: string | null;
}

export async function computeLivedSalesPaths(
  brandId: string,
  offerId: string | null,
  headers: { orgId: string; userId?: string; runId?: string },
  pricing: Pricing,
): Promise<LivedSalesPathsBody> {
  const channels = await resolveBrandChannels(brandId, headers).catch((error: unknown) => {
    if (error instanceof BrandHasNoChannelsError) return [];
    throw error;
  });
  const featureSlugs = brandFeatureSlugs(channels);
  const [journeys, costs, funnelCampaigns, legEconomics, fleetLtr] = await Promise.all([
    fetchBrandJourneys(brandId, headers),
    featureSlugs.length > 0 ? fetchRunsCostUsdByCampaign(brandId, featureSlugs, headers, pricing) : Promise.resolve(new Map<string | null, number>()),
    fetchSalesFunnelCampaigns(brandId, null, headers),
    fetchBrandLegEconomics(brandId, headers.orgId),
    offerLifetimeRevenue(null),
  ]);

  const funnelOfCampaign = new Map<string, FunnelCampaignRef>();
  const offerOfCampaign = new Map<string, string>();
  for (const fc of funnelCampaigns) {
    for (const u of fc.units) {
      funnelOfCampaign.set(u.campaignId, { funnelCampaignId: fc.id, salesFunnelId: fc.salesFunnelId, salesFunnelName: fc.salesFunnelName ?? null });
      offerOfCampaign.set(u.campaignId, fc.offerId);
    }
  }
  const statedLtr = new Map(legEconomics.offers.map((o) => [o.offerId, o.lifetimeRevenueUsd ?? null] as const));
  const lifetimeRevenueOf = (id: string | null): number | null => {
    const stated = id ? statedLtr.get(id) : null;
    return typeof stated === "number" && stated > 0 ? stated : fleetLtr.usd;
  };

  // An OFFER scope keeps that offer's journeys, and the spend of the campaigns that sell it (a funnel unit
  // of the offer, or a campaign that acted on one of its people).
  let scopedCosts = costs;
  if (offerId) {
    const offerCampaigns = new Set<string>([...offerOfCampaign].filter(([, o]) => o === offerId).map(([c]) => c));
    for (const j of journeys) {
      if (j.offerId !== offerId) continue;
      for (const c of [...j.acts.map((a) => a.campaignId), ...j.facts.map((x) => x.campaignId)]) if (c) offerCampaigns.add(c);
    }
    scopedCosts = new Map([...costs].filter(([c]) => c !== null && offerCampaigns.has(c)));
  }

  const catalogue = await catalogueForLivedPaths();
  const lived: LivedPathsResult = computeLivedPaths({
    journeys,
    onlyOfferId: offerId,
    costByCampaign: scopedCosts,
    funnelOfCampaign,
    stepKeys: catalogue.stepKeys,
    lifetimeRevenueOf,
  });
  const withExpected = (rows: LivedPathRow[]): ServedLivedPath[] => rows.map((r) => ({ ...r, expected: catalogue.expectedOf(r.pathId) }));
  return {
    brandId,
    offerId,
    costBasis: "charged",
    pricing,
    since: "inception",
    totals: lived.totals,
    paths: withExpected(lived.paths),
    funnels: lived.funnels.map((f) => ({ ...f, paths: withExpected(f.paths) })),
    expectedUnavailableReason: catalogue.expectedUnavailableReason,
  };
}

const router = Router();

router.get("/brands/:brandId/lived-sales-paths", apiKeyAuth, async (req, res) => {
  const r = req as AuthenticatedRequest;
  const brandId = req.params.brandId;
  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) return res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
  const offerId = typeof req.query.offerId === "string" && req.query.offerId !== "" ? req.query.offerId : null;
  const headers = { orgId: r.orgId, userId: r.userId, runId: r.runId };
  try {
    await assertBrandHeld(brandId, headers);
    const body = await servedCachedJson({
      view: "lived-sales-paths",
      scopeKey: buildScopeKey(brandId, { orgId: r.orgId, offerId: offerId ?? undefined, pricing }),
      orgId: r.orgId,
      compute: () => computeLivedSalesPaths(brandId, offerId, headers, pricing),
    });
    return sendSnapshotJson(res, body);
  } catch (error) {
    if (error instanceof BrandOwnershipError) return res.status(404).json({ error: error.message, reason: "brand_not_found", brandId });
    console.error(`[features-service] lived sales paths of brand ${brandId} failed:`, error);
    return res.status(502).json({ error: "Failed to compute the lived sales paths", reason: "lived_sales_paths_unavailable" });
  }
});

export default router;
