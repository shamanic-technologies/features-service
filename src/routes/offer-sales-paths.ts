/**
 * GET /offers/:offerId/sales-paths — every sales path the offer can sell through, ranked by ROI, each
 * with its per-leg breakdown (rate retained + where it came from, the channel we would run each leg on
 * and why, the cost). The model, the formula and every rule live in `lib/offer-sales-paths.ts`; this
 * route only READS.
 *
 * ADDITIVE: no existing read moves. The per-leg price is read off the byte-same leg-keyed
 * `workflow-projection` ladder (`?leg=&offerId=&pricing=net`) campaign-service ranks on, invoked
 * in-process: the best MATURE workflow's mature price (`priceFromLadder`), never a learning one's flash.
 */
import { StoreNotComputedError } from "../lib/await-warm-store.js";
import { Router } from "express";
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
import { runLadder, type LadderBody } from "../lib/leg-ladder.js";
import { MISSION_PRICE_GRAINS, missionPriceOf } from "../lib/mission-workflow-order.js";

const router = Router();

/**
 * PURE: what one channel's leg-keyed ladder says the leg costs on the customer's EXPECTED-ROI reads — the
 * best MATURE workflow's mature price (owner rule 2026-10-05, features-service#1360).
 *
 * Not the recommendation: since 2026-10-01 a LEARNING workflow cheaper than the best mature one is rank 1
 * and gets the money (unchanged), but its flash price is unproven, and an expected ROI labelled "Our best
 * workflow" must rest on a proven one. So the leg is priced on the selectable, non-retired workflow whose
 * brand row holds a mature price, in the mission order's own precedence (`missionPriceOf`): finest grain
 * first (offer > brand > crossOrg), cheapest within it, slug last. No such workflow = no workflow price, and
 * the leg falls to the fleet-measured / default rungs (`costSource` says which).
 */
export function priceFromLadder(status: number, body: LadderBody): LegChannelPrice {
  if (status !== 200) {
    return { costPerOutcomeUsd: null, workflowDynastySlug: null, grain: null, unpricedReason: body.reason ?? `ladder_${status}` };
  }
  const best = (body.rows ?? [])
    .filter((r) => r.audienceId === null && r.retired !== true && r.legAssignment?.selectable !== false)
    .map((r) => {
      const g = r.estimatesByGrain ?? {};
      const price = missionPriceOf({ grains: { offer: g.offer ?? null, brand: g.brand ?? null, crossOrg: g.crossOrg ?? null } });
      return price ? { slug: r.workflow.workflowDynastySlug, ...price } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort(
      (a, b) =>
        MISSION_PRICE_GRAINS.indexOf(a.grain) - MISSION_PRICE_GRAINS.indexOf(b.grain) ||
        a.costPerOutcomeUsd - b.costPerOutcomeUsd ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    )[0];
  if (!best) {
    return {
      costPerOutcomeUsd: null,
      workflowDynastySlug: null,
      grain: null,
      unpricedReason: body.recommendationWithheldReason ?? body.unmeasuredReason ?? "no_mature_workflow",
    };
  }
  return { costPerOutcomeUsd: best.costPerOutcomeUsd, workflowDynastySlug: best.slug, grain: best.grain, unpricedReason: null };
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
