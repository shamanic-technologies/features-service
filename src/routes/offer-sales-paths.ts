/**
 * GET /offers/:offerId/sales-paths — every sales path the offer can sell through, ranked by ROI, each
 * with its per-leg breakdown (rate retained + where it came from, the channel we would run each leg on
 * and why, the cost). The model, the formula and every rule live in `lib/offer-sales-paths.ts`; this
 * route only READS.
 *
 * ADDITIVE: no existing read moves. The per-leg price is the byte-same leg-keyed `workflow-projection`
 * ladder (`?leg=&offerId=&pricing=net`) campaign-service ranks on, invoked in-process so the best
 * workflow per leg is picked exactly the way it is picked everywhere else.
 */
import { StoreNotComputedError } from "../lib/await-warm-store.js";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { features } from "../db/schema.js";
import { buildChannelCatalogue } from "../lib/channel-catalogue.js";
import { fetchBrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { getBrandEffectiveRates } from "../lib/effective-conversion-rates.js";
import { SalesFunnelsUnavailableError } from "../lib/sales-funnels-client.js";
import { fetchOfferChannels, fetchOfferSalesPath, fetchOfferSelectedSalesPaths, OfferSalesPathNotFoundError } from "../lib/offer-sales-path-client.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import {
  acceptedCatalogueChannels,
  buildOfferSalesPaths,
  enumerateSalesPaths,
  legChannelsForScope,
  MANAGED_CHANNEL_SLUGS,
  priceKey,
  type LegChannelPrice,
  type SalesPathChannelInput,
  type SalesPathScope,
  withCampaignRois,
  withSalesPathNames,
} from "../lib/offer-sales-paths.js";
import { campaignNamesOf, salesPathNamesFor, SalesPathNamePoolExhaustedError, withCampaignNames } from "../lib/sales-path-names.js";
import { handleWorkflowProjection } from "./workflow-projection.js";

const router = Router();

interface LadderBody {
  recommendedWorkflowDynastySlug?: string | null;
  rows?: Array<{
    audienceId: string | null;
    workflow: { workflowDynastySlug: string };
    resolved: { grain: string | null; costPerOutcomeUsd: number | null };
  }>;
  reason?: string;
  unmeasuredReason?: string;
  recommendationWithheldReason?: string;
  recommendationBasis?: string;
}

/** Run the customer `workflow-projection` handler in-process and capture its answer. */
function runLadder(
  identity: { orgId: string; userId: string; runId: string },
  featureSlug: string,
  query: Record<string, string>,
): Promise<{ status: number; body: LadderBody }> {
  return new Promise((resolve, reject) => {
    const req = {
      params: { featureSlug },
      query,
      headers: {},
      orgId: identity.orgId,
      userId: identity.userId,
      runId: identity.runId,
      featureSlug,
    } as unknown as Request;
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(body: LadderBody) {
        resolve({ status, body });
        return res;
      },
    } as unknown as Response;
    handleWorkflowProjection(req, res, "billed").catch(reject);
  });
}

/** PURE: what one channel's leg-keyed ladder says the leg costs, read off the recommended workflow's brand row. */
export function priceFromLadder(status: number, body: LadderBody): LegChannelPrice {
  if (status !== 200) {
    return { costPerOutcomeUsd: null, workflowDynastySlug: null, grain: null, unpricedReason: body.reason ?? `ladder_${status}` };
  }
  // A cold-start pick names a workflow to RUN, not a price: the leg stays priced from the fleet /
  // default rungs exactly as before (its row's explore allowance is a floor, never a leg price).
  const slug = body.recommendationBasis === "cold_start" ? null : (body.recommendedWorkflowDynastySlug ?? null);
  if (!slug) {
    return {
      costPerOutcomeUsd: null,
      workflowDynastySlug: null,
      grain: null,
      unpricedReason: body.recommendationWithheldReason ?? body.unmeasuredReason ?? "no_recommended_workflow",
    };
  }
  const row = (body.rows ?? []).find((r) => r.audienceId === null && r.workflow.workflowDynastySlug === slug) ?? null;
  const cost = row?.resolved.costPerOutcomeUsd ?? null;
  return {
    costPerOutcomeUsd: cost,
    workflowDynastySlug: slug,
    grain: row?.resolved.grain ?? null,
    unpricedReason: cost === null ? "recommended_workflow_unpriced" : null,
  };
}

router.get("/offers/:offerId/sales-paths", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as AuthenticatedRequest;
  const offerId = req.params.offerId as string;
  const brandId = ((req.query.brandId as string | undefined) ?? "").trim();
  if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });
  const rawScope = ((req.query.scope as string | undefined) ?? "").trim();
  if (rawScope !== "" && rawScope !== "ticked" && rawScope !== "catalogue") {
    return res.status(400).json({ error: `scope must be ticked or catalogue, got ${rawScope}`, reason: "scope_unrecognised" });
  }
  const scope: SalesPathScope = rawScope === "catalogue" ? "catalogue" : "ticked";
  const identity = { orgId: req.orgId, userId: req.userId, runId: req.runId };

  try {
    const [salesPath, legEconomics, offerChannels, selectedPaths] = await Promise.all([
      fetchOfferSalesPath(offerId),
      fetchBrandLegEconomics(brandId, req.orgId),
      scope === "catalogue" ? fetchOfferChannels(offerId) : Promise.resolve(null),
      fetchOfferSelectedSalesPaths(offerId),
    ]);
    // The catalogue lists only the channels the offer accepts (never stated = the three we run).
    const catalogueChannelSlugs = offerChannels ? acceptedCatalogueChannels(offerChannels) : undefined;
    const offer = legEconomics.offers.find((o) => o.offerId === offerId);
    if (!offer) {
      return res.status(404).json({ error: `offer ${offerId} is not an offer of brand ${brandId}`, reason: "offer_not_found" });
    }

    const [rates, rows] = await Promise.all([
      getBrandEffectiveRates(brandId, req.orgId, legEconomics),
      db.query.features.findMany({ where: eq(features.status, "active") }),
    ]);
    // Every sales-path campaign named first, in catalogue order (the same names `/public/channels` serves).
    const published = await withCampaignNames(buildChannelCatalogue(rows));
    const channels: SalesPathChannelInput[] = published.map((c) => ({
      slug: c.slug,
      name: c.name,
      operatedBy: c.operatedBy,
      trigger: c.trigger,
      legKeys: c.stepTransitions.map((t) => t.legKey),
    }));

    // Only the (leg, MANAGED channel) pairs a complete path needs run a ladder: a channel we do not run has
    // no workflow to rank (it prices on the fleet's spend, else its benchmark, in the pure build).
    const pairs = new Map<string, { legKey: string; slug: string }>();
    const ticked = salesPath.stated ? (salesPath.legKeys ?? []) : [];
    for (const chain of enumerateSalesPaths(ticked)) {
      for (const legKey of chain) {
        for (const c of legChannelsForScope(channels, legKey, scope, MANAGED_CHANNEL_SLUGS, catalogueChannelSlugs)) {
          if (MANAGED_CHANNEL_SLUGS.has(c.slug)) pairs.set(priceKey(legKey, c.slug), { legKey, slug: c.slug });
        }
      }
    }
    const prices = new Map<string, LegChannelPrice>();
    await mapWithConcurrency([...pairs.values()], 4, async ({ legKey, slug }) => {
      try {
        const { status, body } = await runLadder(identity, slug, { brandId, leg: legKey, offerId, pricing: "net" });
        prices.set(priceKey(legKey, slug), priceFromLadder(status, body));
      } catch (error) {
        console.error(`[features-service] sales-paths: ladder ${slug}/${legKey} failed: ${(error as Error).message}`);
        prices.set(priceKey(legKey, slug), { costPerOutcomeUsd: null, workflowDynastySlug: null, grain: null, unpricedReason: "ladder_failed" });
      }
    });

    // The cascade's middle rung: the fleet's measured cost per outcome, from the last outcome-prices build
    // (lazy import: that router is large). Right after a boot the store is EMPTY for the minutes its first
    // build takes; this read awaits that build, and fails VISIBLY (503) past the bound — never prices a
    // measured leg at its seeded default because the process is young (2026-10-03: $5 vs $1.41).
    const fleetPrices = await (await import("./public.js")).awaitFleetLegCostsFromOutcomePrices();

    const body = buildOfferSalesPaths({
      offerId,
      brandId,
      stated: salesPath.stated,
      statedAt: salesPath.statedAt,
      legKeys: salesPath.legKeys,
      lifetimeRevenueUsd: offer.lifetimeRevenueUsd,
      rates: rates.legs,
      channels,
      prices,
      fleetPrices,
      scope,
      catalogueChannelSlugs,
    });
    // Every row's name, shared across clients and stable forever: assigned on first sight, in rank order.
    const names = await salesPathNamesFor(body.paths.map((p) => p.combinationKey));
    // Every campaign (channel × leg) with its ROI, read off the paths the customer selected.
    return res.json(withCampaignRois(withSalesPathNames(body, names, campaignNamesOf(published)), selectedPaths));
  } catch (error) {
    if (error instanceof OfferSalesPathNotFoundError) {
      return res.status(404).json({ error: error.message, reason: "offer_not_found" });
    }
    if (error instanceof StoreNotComputedError) {
      console.error(`[features-service] sales-paths for offer ${offerId}: ${error.message}`);
      res.setHeader("Retry-After", "60");
      return res.status(503).json({ error: error.message, reason: "fleet_costs_not_computed_yet" });
    }
    if (error instanceof SalesPathNamePoolExhaustedError) {
      console.error(`[features-service] sales-paths for offer ${offerId}: ${error.message}`);
      return res.status(502).json({ error: error.message, reason: "sales_path_name_pool_exhausted" });
    }
    if (error instanceof SalesFunnelsUnavailableError) {
      return res.status(502).json({ error: error.message, reason: "brand_service_unavailable" });
    }
    console.error(`[features-service] sales-paths error for offer ${offerId}:`, error);
    return res.status(502).json({ error: "Failed to compute the offer's sales paths" });
  }
});

export default router;
