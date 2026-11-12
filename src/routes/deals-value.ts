/**
 * GET /brands/:brandId/deals-value — what each Deals-board column holds in dollars
 * (`lib/deals-value.ts`), per column and per card.
 *
 * A SEPARATE figure: it is added to no pipeline, no ROI, no cost of acquisition and no existing body.
 * WHICH people sit in a column is lead-service's standing (its `?standing=` filter, read here); what
 * they are worth is priced on the byte-same inputs the brand's pipeline is priced on
 * (`loadBrandPricedPopulation`, shared with contacted-value), so an Interested card reads the same
 * number the engine prices that person at (on every outcome cause — see computeBrandDealsValue).
 */
import { withInteractiveReads } from "../lib/lead-copy.js";
import { ContactedValueUnavailableError, contactedValueUnavailableBody } from "../lib/contacted-value-unavailable.js";
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld } from "../lib/brand-ownership.js";
import { resolveBrandChannels, brandFeatureSlugs, BrandHasNoChannelsError } from "../lib/brand-channels.js";
import { servedCachedWrappedJson, sendSnapshotJson, buildScopeKey, type SnapshotJson } from "../lib/view-cache.js";
import { fetchLeadIdsByStanding } from "../lib/leads-client.js";
import { DEFAULT_PRICED_CAUSES } from "../lib/outcome-cause.js";
import { loadBrandPricedPopulation, BrandPricesDifferentlyError, type BrandPricingPre } from "./contacted-value.js";
import { priceDealsColumns, type DealsValueResult } from "../lib/deals-value.js";
import { withLedgerDealsColumns } from "../lib/ledger-counts.js";
import { readLedgerScope } from "../lib/ledger-counts-io.js";
import { fetchOfferChannelMap, offerCampaignIds, offerFeatureSlugs, type OfferChannelMap } from "../lib/offer-channels.js";
import { OfferChannelsPriceDifferentlyError } from "./offer-economics.js";
import { campaignSetKey, computeOfferCompanyLifecycle } from "../lib/company-lifecycle-io.js";
import type { CompanyLifecycleResult } from "../lib/company-lifecycle.js";
import { computeBrandDealsLifecycle, offerPricing, type BrandDealsLifecycleResult, type BrandOfferPricing } from "./offer-lead-values.js";

const router = Router();

/** The brand's column values, computed once per refresh (the Gold snapshot layer caches it). */
export async function computeBrandDealsValue(
  brandId: string,
  headers: DownstreamHeaders,
  pre: BrandPricingPre,
  /**
   * The OFFER grain: only the people served on the offer's campaigns. lead-service's standing is
   * brand-keyed, so a column is the brand's members INTERSECTED with the offer's lead population — a
   * person this offer never worked is not on its board. Omitted → the whole brand (byte-unchanged).
   */
  campaignIds?: string[],
  /** The offer whose Disqualified marks apply (its own or brand-wide); omitted → every mark of the brand. */
  offerId?: string,
): Promise<DealsValueResult> {
  // ONE pipeline figure everywhere (owner 2026-10-21, « On fait tout (toute campaign, tout sales funnels, tout
  // pipes) »; supersedes the 2026-09-26 every-cause board): both columns are priced on the pipeline's own default
  // causes (`DEFAULT_PRICED_CAUSES`, what our pipes caused); a deal that came on its own adds nothing.
  // "Disqualified" is lead-service's MARK beside the standing (v0.83.59), not a standing: a marked person
  // can still stand Interested. The population carries the mark (read once, by the loader, the offer's
  // when offer-scoped), so the card reads $0 `ruled_out` exactly as the pipeline prices that person.
  const [population, interested, won] = await Promise.all([
    loadBrandPricedPopulation(brandId, headers, pre, { pricedCauses: DEFAULT_PRICED_CAUSES, campaignIds, offerId }),
    fetchLeadIdsByStanding(brandId, "sales_interest", headers),
    fetchLeadIdsByStanding(brandId, "customer", headers),
  ]);

  // The WON amount is the one stated on the SALE. Unreadable statements (fail-soft in the loader) leave
  // every won card on the brand's value of a client, and each card says so.
  let statedWonAmountUsdByEmail: Map<string, number> | null = null;
  if (population.observed) {
    statedWonAmountUsdByEmail = new Map();
    for (const [email, f] of population.observed.byEmail) {
      if ("closeWin" in f.reached && f.valueUsd !== null) statedWonAmountUsdByEmail.set(email, f.valueUsd);
    }
  }

  // At the offer grain a brand member outside the offer's population is not in the offer's column, so
  // `unpricedLeadCount` is always 0 there (the two reads cannot be told apart from a lead-service race).
  const held = new Set(population.persons.map((p) => p.leadId));
  const scoped = (members: Set<string>): Set<string> =>
    campaignIds ? new Set([...members].filter((id) => held.has(id))) : members;

  // LEDGER-ONLY-1107-P2: the won column's value is the brand ledger's Paid client Units x LTR.
  return withLedgerDealsColumns(
    priceDealsColumns({
      persons: population.persons,
      paths: population.paths,
      lifetimeRevenueUsd: population.lifetimeRevenueUsd,
      members: { sales_interest: scoped(interested), customer: scoped(won) },
      statedWonAmountUsdByEmail,
      pricedCauses: DEFAULT_PRICED_CAUSES,
    }) as DealsValueResult & { columns: Array<Record<string, unknown> & { standing: string; basis: string | null }> },
    await readLedgerScope(brandId, "net", null, "deals value"),
  ) as DealsValueResult;
}

/**
 * BRAND-GRAIN-READS-1107 (owner 2026-11-07: the dashboard reads every brand page at BRAND grain; a brand sells several
 * offers). The brand's scope for the lifecycle reads = every offer any of its campaigns states, every campaign of each
 * (the union of the offer grain's scopes), so a brand selling ONE offer reads its offer's body byte for byte.
 */
export function brandOfferScope(map: OfferChannelMap): { offerIds: string[]; campaignIds: string[]; featureSlugs: string[] } {
  const channels = map.offerIds.flatMap((o) => map.channelsOf(o));
  return {
    offerIds: map.offerIds,
    campaignIds: [...new Set(offerCampaignIds(channels))].sort(),
    featureSlugs: [...new Set(offerFeatureSlugs(channels))].sort(),
  };
}

export class BrandHasNoOfferCampaignsError extends Error {
  constructor(readonly brandId: string) {
    super(`no campaign of brand ${brandId} sells an offer, so its lifecycle has no scope`);
  }
}

/** `?columns=lifecycle` / `company_lifecycle` at the BRAND grain (the offer read's modes, every offer of the brand). */
export async function brandLifecycleRead(brandId: string, headers: DownstreamHeaders, columns: "lifecycle" | "company_lifecycle"): Promise<SnapshotJson> {
  const [map] = await Promise.all([withInteractiveReads(() => fetchOfferChannelMap(brandId, headers)), assertBrandHeld(brandId, headers)]);
  const scope = brandOfferScope(map);
  if (scope.offerIds.length === 0) throw new BrandHasNoOfferCampaignsError(brandId);
  // The served body is `{ brandId, offerIds, ...cell }`, serialized once per stored cell (DASH-SPEED-1110).
  const envelope = { brandId, offerIds: scope.offerIds };
  if (columns === "company_lifecycle") {
    return servedCachedWrappedJson<CompanyLifecycleResult>({
      view: "brand-company-lifecycle",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: scope.featureSlugs.join("+"),
        campaigns: campaignSetKey(scope.campaignIds),
        m: "company-lifecycle-v1",
      }),
      orgId: headers.orgId,
      compute: () => computeOfferCompanyLifecycle(brandId, headers, scope.campaignIds),
    }, envelope);
  }
  const offers: Array<BrandOfferPricing & { keyParts: { decl: string; econ: string } }> = await Promise.all(
    scope.offerIds.map(async (offerId) => {
      const channels = map.channelsOf(offerId);
      const { pre, keyParts } = await offerPricing(offerId, brandId, headers, channels);
      return { offerId, campaignIds: offerCampaignIds(channels), pre, keyParts };
    }),
  );
  return servedCachedWrappedJson<BrandDealsLifecycleResult>({
    view: "brand-deals-lifecycle",
    scopeKey: buildScopeKey(brandId, {
      orgId: headers.orgId,
      channels: scope.featureSlugs.join("+"),
      offers: offers.map((o) => `${o.offerId}>${campaignSetKey(o.campaignIds)}>${o.keyParts.decl}>${o.keyParts.econ}`).join(","),
      m: "brand-deals-lifecycle-v1",
    }),
    orgId: headers.orgId,
    compute: () => computeBrandDealsLifecycle(brandId, headers, offers),
  }, envelope);
}

router.get("/brands/:brandId/deals-value", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as unknown as AuthenticatedRequest;
  const brandId = rawReq.params.brandId as string;
  const headers: DownstreamHeaders = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  const columns = rawReq.query.columns === undefined ? "standing" : rawReq.query.columns;
  if (columns !== "standing" && columns !== "lifecycle" && columns !== "company_lifecycle") {
    return res.status(400).json({ error: "columns must be one of: standing, lifecycle, company_lifecycle" });
  }
  try {
    if (columns !== "standing") return sendSnapshotJson(res, await brandLifecycleRead(brandId, headers, columns));
    // The pre-cache reads share the burst's answers (lib/lead-copy.ts withInteractiveReads), like /brands/:id/revenue.
    const channels = await withInteractiveReads(() => resolveBrandChannels(brandId, headers));
    const [declared] = await Promise.all([withInteractiveReads(() => fetchDeclaredFunnelsSoft(brandId, headers.orgId)), assertBrandHeld(brandId, headers)]);
    const priced = priceOnDeclaredFunnel(declared);
    const body = await servedCachedWrappedJson({
      view: "brand-deals-value",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: brandFeatureSlugs(channels).join("+"),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: pricedFingerprint(priced),
        m: "deals-value-v5",
      }),
      orgId: headers.orgId,
      compute: () => computeBrandDealsValue(brandId, headers, { channels, declared }),
    }, { brandId });
    return sendSnapshotJson(res, body);
  } catch (error) {
    if (error instanceof BrandHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "brand_has_no_channels", brandId });
    }
    if (error instanceof BrandPricesDifferentlyError) {
      return res.status(409).json({ error: error.message, reason: "brand_channels_price_differently", brandId });
    }
    if (error instanceof BrandHasNoOfferCampaignsError) {
      return res.status(404).json({ error: error.message, reason: "brand_has_no_offer_campaigns", brandId });
    }
    if (error instanceof OfferChannelsPriceDifferentlyError) {
      return res.status(409).json({ error: error.message, reason: "offer_channels_price_differently", brandId, offerId: error.offerId });
    }
    if (error instanceof ContactedValueUnavailableError) return res.status(503).json(contactedValueUnavailableBody(error));
    console.error(`[features-service] Brand deals value error:`, error);
    return res.status(502).json({ error: "Failed to compute brand deals value" });
  }
});

export default router;
