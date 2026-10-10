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
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { StoreNotComputedError } from "../lib/await-warm-store.js";
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { loadChannelCatalogue } from "../lib/channel-declarations-store.js";
import { fetchBrandLegEconomics } from "../lib/brand-leg-economics-client.js";
import { getBrandEffectiveRates } from "../lib/effective-conversion-rates.js";
import { SalesFunnelsUnavailableError } from "../lib/sales-funnels-client.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { offerFunnelSelection } from "../lib/offer-funnel-campaigns.js";
import { storedCombinationKeyOf, storedLegKeyOf } from "../lib/funnel-legs.js";
import { legacyOutboundLegKeysIn, noteLegacyOutboundLegKeys } from "../lib/legacy-leg-key-arrivals.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import {
  buildOfferSalesPaths,
  DEFAULT_OUTCOMES_CREDIT_USD,
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
import { buildSourceCampaigns, sourceCampaignNameKeys, sourceCampaignOrigins, sourceOverlapOf, withSourceCampaigns } from "../lib/source-campaigns.js";
import { readOfferSourcing, type OfferSourcingPayload } from "./offer-sourcing.js";

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
  const rawCredit = ((req.query.creditUsd as string | undefined) ?? "").trim();
  const creditUsd = rawCredit === "" ? DEFAULT_OUTCOMES_CREDIT_USD : Number(rawCredit);
  if (!Number.isFinite(creditUsd) || creditUsd <= 0 || creditUsd > 1_000_000) {
    return res.status(400).json({ error: `creditUsd must be a positive number of dollars up to 1000000, got ${rawCredit}`, reason: "credit_unrecognised" });
  }
  const identity = { orgId: req.orgId, userId: req.userId, runId: req.runId };

  // The offer's SOURCE CAMPAIGNS read the same Gold cell as `/offers/:id/sourcing?pricing=net` (started now,
  // awaited last). A failure lists the source campaigns with null figures (`sourcing_unavailable`), loudly:
  // the paths and the outreach campaigns never depend on it.
  const sourcingP: Promise<OfferSourcingPayload | null> = readOfferSourcing({ offerId, brandId, pricing: "net", identity }).catch((error) => {
    console.error(`[features-service] sales-paths for offer ${offerId}: source campaigns unreadable (sourcing_unavailable): ${(error as Error).message}`);
    return null;
  });

  try {
    // HOW THE OFFER SELLS is read off its SALES FUNNEL CAMPAIGNS (owner 2026-10-10, `lib/offer-funnel-campaigns.ts`):
    // the legs of every funnel it has a campaign on, the funnels whose campaign is on as its selection. brand-service's
    // per-offer ticked legs, accepted channels and ticked paths are retired; the catalogue scope lists the shortlist.
    const [rows, legEconomics] = await Promise.all([
      fetchBrandCampaignRows(brandId, undefined, { orgId: req.orgId, userId: req.userId, runId: req.runId }),
      fetchBrandLegEconomics(brandId, req.orgId),
    ]);
    const fromFunnels = offerFunnelSelection(rows, offerId, legEconomics.offers.length === 1);
    const statedSalesPath = fromFunnels.salesPath;
    const statedSelectedPaths = fromFunnels.selected;
    // Both spellings of an outbound leg are ONE identity (wave 1, `lib/funnel-legs.ts`): the funnels' legs and ids are
    // read in the spelling this service stores and serves, so a `lead_found_to_*` one finds the same chain, row, name
    // and selection as its `start_to_*` twin. A legacy spelling reads byte-identical (resolution is the identity on it).
    noteLegacyOutboundLegKeys(legacyOutboundLegKeysIn(statedSelectedPaths.combinationKeys ?? []), {
      source: "campaign-service",
      route: "GET /campaigns (salesFunnelId)",
      caller: { service: "campaign-service", orgId: req.orgId },
    });
    const salesPath = statedSalesPath.legKeys ? { ...statedSalesPath, legKeys: statedSalesPath.legKeys.map(storedLegKeyOf) } : statedSalesPath;
    const selectedPaths = statedSelectedPaths?.combinationKeys
      ? { ...statedSelectedPaths, combinationKeys: statedSelectedPaths.combinationKeys.map(storedCombinationKeyOf) }
      : statedSelectedPaths;
    // The catalogue scope lists the shortlist (the per-offer accepted channels are retired with brand-service's store).
    const catalogueChannelSlugs = undefined;
    const offer = legEconomics.offers.find((o) => o.offerId === offerId);
    if (!offer) {
      return res.status(404).json({ error: `offer ${offerId} is not an offer of brand ${brandId}`, reason: "offer_not_found" });
    }

    // Every offer has a lifetime revenue: its own, else the fleet median (owner 2026-10-09).
    const lifetimeRevenue = await offerLifetimeRevenue(offer.lifetimeRevenueUsd);

    const [rates, catalogue] = await Promise.all([
      getBrandEffectiveRates(brandId, req.orgId, legEconomics),
      // Seeded channels + every PUBLISHED run-time declaration (`lib/channel-declarations.ts`).
      loadChannelCatalogue({ publishedOnly: true }),
    ]);
    // Every sales-path campaign named first, in catalogue order (the same names `/public/channels` serves).
    const published = await withCampaignNames(catalogue.channels);
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
      lifetimeRevenueUsd: lifetimeRevenue.usd,
      rates: rates.legs,
      channels,
      prices,
      fleetPrices,
      scope,
      catalogueChannelSlugs,
    });
    // Every row's name, shared across clients and stable forever: assigned on first sight, in rank order.
    const names = await salesPathNamesFor(body.paths.map((p) => p.combinationKey));
    // Every campaign (channel × leg) with its ROI and what `creditUsd` buys of its outcome, read off the paths the customer selected.
    const withRois = withCampaignRois(withSalesPathNames(body, names, campaignNamesOf(published)), selectedPaths, creditUsd);
    // Then the source campaigns beside them (named from the same pool, in catalogue order), and `fedBy` on the outreach ones.
    const sourcing = await sourcingP;
    const sourceNames = await salesPathNamesFor(sourceCampaignNameKeys(sourceCampaignOrigins(sourcing)));
    return res.json({
      ...withSourceCampaigns(withRois, buildSourceCampaigns({ sourcing, names: sourceNames }), sourceOverlapOf(sourcing)),
      lifetimeRevenueSource: lifetimeRevenue.source,
    });
  } catch (error) {
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
