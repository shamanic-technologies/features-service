/**
 * WHAT AN OFFER'S PEOPLE ARE WORTH — the Deals-board column values and the contacted-but-not-engaged
 * value, for ONE offer of a brand, across every channel it is sold through.
 *
 *   GET /offers/:offerId/deals-value?brandId=      — `/brands/:brandId/deals-value`, at the offer grain
 *   GET /offers/:offerId/contacted-value?brandId=  — `/brands/:brandId/contacted-value`, at the offer grain
 *   GET /offers/:offerId/deals-value?brandId=&columns=lifecycle[&campaignId=] — the board on the LIFECYCLE ladder
 *       (`computeOfferDealsLifecycle`); without `columns` (or `columns=standing`) the standing body, byte-unchanged.
 *   GET /offers/:offerId/deals-value?brandId=&columns=company_lifecycle — each organisation's lifecycle rung (the
 *       highest rung of its people) and how many stand on each rung, for the Companies page
 *       (`computeOfferCompanyLifecycle`, `lib/company-lifecycle.ts`). A mode of this route so the gateway's existing
 *       passthrough reaches it.
 *
 * Same semantics, same pricing and same body as the brand reads; what narrows is WHO: only the leads
 * served on the offer's campaigns (every channel), read the way `/offers/:offerId/revenue` reads them,
 * priced on the OFFER's declared funnels and LTR (the same `fetchDeclaredFunnelsSoft(…, offerId)` the
 * offer's revenue prices on). So each figure is the one the offer's own revenue read carries:
 *
 *   - Interested = each person at the engine's expected value on every cause, a SUBSET of
 *     `/offers/:offerId/revenue?cause=outreach,other,unstated`'s pipeline.
 *   - Contacted value = what these leads add to `/offers/:offerId/revenue`'s pipeline. The per-(campaign
 *     × workflow) ENTRY RATES are the brand cell's (the one cell every pipeline read prices a contacted
 *     lead on), borrowed as is: a group is one campaign, so its rate applies unchanged to the offer's
 *     leads — and a second computation could price the column off a different number than the pipeline.
 *
 * People do not add across offers: a lead served under two offers is in both offers' populations (it is
 * one person to each), so offer A + offer B can exceed the brand. A brand member no campaign of this
 * offer served is not on the offer's board.
 *
 * An offer no campaign sells is 404 `offer_has_no_channels`, never the brand's numbers. `?pricing=` is
 * accepted and validated like every offer read (no figure here is a cost, so it moves nothing).
 */
import { createHash } from "node:crypto";
import { Router } from "express";
import { apiKeyAuth } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld } from "../lib/brand-ownership.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { OfferHasNoChannelsError, type OfferChannel } from "../lib/offer-channels.js";
import { resolveRequest, resolveOfferFunnel, OfferChannelsPriceDifferentlyError } from "./offer-economics.js";
import {
  getBrandContactedValue,
  loadBrandPricedPopulation,
  parseContactedValuePage,
  pageContactedValue,
} from "./contacted-value.js";
import { computeBrandDealsValue } from "./deals-value.js";
import { priceContactedLeads, type ContactedValueResult } from "../lib/contacted-value.js";
import type { DealsValueResult } from "../lib/deals-value.js";
import { ALL_OUTCOME_CAUSES } from "../lib/outcome-cause.js";
import { fetchLeadsForRevenue, fetchUniboxLifecycleRows } from "../lib/leads-client.js";
import { dedupPersonsByLead } from "../lib/revenue-engine.js";
import { LIFECYCLE_RUNGS } from "../lib/lifecycle-ladder.js";
import { companyLifecycles, type CompanyLifecycleResult } from "../lib/company-lifecycle.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import {
  BOARD_RUNG_KEYS,
  priceLifecycleColumns,
  type BoardRungKey,
  type DealsLifecycleResult,
  type LifecycleBoardRow,
} from "../lib/deals-lifecycle.js";

const router = Router();

/**
 * The offer's campaign SET in the key (a newly launched campaign moves every figure while no other key
 * part does), hashed: an offer can carry hundreds of campaigns and the key sits in a btree index.
 */
function campaignSetKey(campaignIds: string[]): string {
  return createHash("sha1").update(campaignIds.join("+")).digest("hex").slice(0, 12);
}

/** Why the brand's entry rates could not be borrowed (every lead then reads unpriced, as in the pipeline). */
export type BrandEntryRatesUnavailableReason =
  | "brand_contacted_value_unreadable"
  | "no_economics"
  | "no_client_value"
  | "no_entry_path"
  | "no_entry_rate";

export type OfferContactedValueResult = ContactedValueResult & {
  /** Where `workflows[]` (each group's entry rates) comes from: always the brand's contacted-value cell. */
  entryRatesFrom: "brand";
  brandEntryRatesUnavailableReason: BrandEntryRatesUnavailableReason | null;
};

/** The offer's pricing inputs, read once to key the cache and handed to the compute. */
async function offerPricing(offerId: string, brandId: string, headers: DownstreamHeaders, channels: OfferChannel[]) {
  // Fails loud on several funnels BEFORE the population loader asks the brand-worded question.
  resolveOfferFunnel(offerId, channels);
  const [declared] = await Promise.all([fetchDeclaredFunnelsSoft(brandId, headers.orgId, offerId), assertBrandHeld(brandId, headers)]);
  const priced = priceOnDeclaredFunnel(declared);
  return {
    pre: { channels, declared },
    keyParts: {
      decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
      econ: pricedFingerprint(priced),
    },
  };
}

/** PURE-ish. The offer's contacted value: its population and terms, the brand's entry rates. */
export async function computeOfferContactedValue(
  brandId: string,
  headers: DownstreamHeaders,
  pre: Parameters<typeof loadBrandPricedPopulation>[2],
  campaignIds: string[],
  /** The offer whose Disqualified marks apply (its own or brand-wide). */
  offerId: string,
): Promise<OfferContactedValueResult> {
  const [population, brandCell] = await Promise.all([
    loadBrandPricedPopulation(brandId, headers, pre, { campaignIds, offerId }),
    // Soft, exactly like the pipeline's own read of this cell (`contactedPricingSoft`): unreadable →
    // no rate, which is what the offer's pipeline prices these leads on too.
    getBrandContactedValue(brandId, headers).catch((err: Error) => {
      console.warn(`[features-service] offer contacted value (brand ${brandId}): brand entry rates unreadable — every lead unpriced: ${err.message}`);
      return null;
    }),
  ]);
  const unavailable: BrandEntryRatesUnavailableReason | null =
    brandCell === null ? "brand_contacted_value_unreadable" : brandCell.unmeasuredReason;
  const result = priceContactedLeads({
    paths: population.paths,
    persons: population.persons,
    lifetimeRevenueUsd: population.lifetimeRevenueUsd,
    entryRatesFrom: unavailable === null ? brandCell!.workflows : null,
  });
  return { ...result, entryRatesFrom: "brand", brandEntryRatesUnavailableReason: unavailable };
}

function offerError(res: import("express").Response, error: unknown, what: string) {
  if (error instanceof CampaignNotOnOfferError) {
    return res.status(404).json({ error: error.message, reason: "campaign_not_on_offer", offerId: error.offerId, campaignId: error.campaignId });
  }
  if (error instanceof OfferHasNoChannelsError) {
    return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
  }
  if (error instanceof OfferChannelsPriceDifferentlyError) {
    return res.status(409).json({ error: error.message, reason: "offer_channels_price_differently", offerId: error.offerId });
  }
  console.error(`[features-service] Offer ${what} error:`, error);
  return res.status(502).json({ error: `Failed to compute offer ${what}` });
}

/**
 * The LIFECYCLE board (owner 2026-10-21, DEALS-LIFECYCLE-1021; `lib/deals-lifecycle.ts`): one column per rung of the
 * lifecycle ladder, membership = lead-service's Unibox `lifecycle` (read), INTERSECTED with the scope's lead
 * population (the offer's campaigns, or one campaign of it), priced on the same engine as the standing board.
 */
export async function computeOfferDealsLifecycle(
  brandId: string,
  headers: DownstreamHeaders,
  pre: Parameters<typeof loadBrandPricedPopulation>[2],
  campaignIds: string[],
  offerId: string,
): Promise<DealsLifecycleResult> {
  const [population, uniboxRows, brandCell] = await Promise.all([
    loadBrandPricedPopulation(brandId, headers, pre, { pricedCauses: ALL_OUTCOME_CAUSES, campaignIds, offerId }),
    fetchUniboxLifecycleRows(brandId, BOARD_RUNG_KEYS, headers),
    // Soft, exactly like the offer's contacted-value read: unreadable → the seeded entry benchmark, said so per card.
    getBrandContactedValue(brandId, headers).catch((err: Error) => {
      console.warn(`[features-service] offer deals lifecycle (brand ${brandId}): brand entry rates unreadable — contacted cards on the default entry rate: ${err.message}`);
      return null;
    }),
  ]);
  const contacted = priceContactedLeads({
    paths: population.paths,
    persons: population.persons,
    lifetimeRevenueUsd: population.lifetimeRevenueUsd,
    entryRatesFrom: brandCell === null || brandCell.unmeasuredReason !== null ? null : brandCell.workflows,
  });
  let statedWonAmountUsdByEmail: Map<string, number> | null = null;
  if (population.observed) {
    statedWonAmountUsdByEmail = new Map();
    for (const [email, f] of population.observed.byEmail) {
      if ("closeWin" in f.reached && f.valueUsd !== null) statedWonAmountUsdByEmail.set(email, f.valueUsd);
    }
  }
  const rungs = new Set<string>(BOARD_RUNG_KEYS);
  const rows: LifecycleBoardRow[] = uniboxRows
    .filter((r) => rungs.has(r.rung))
    .map((r) => ({ humanId: r.humanId, companyKey: r.companyKey, relationKey: r.relationKey, leadIds: r.leadIds, rung: r.rung as BoardRungKey }));
  return priceLifecycleColumns({
    rows,
    persons: population.persons,
    paths: population.paths,
    lifetimeRevenueUsd: population.lifetimeRevenueUsd,
    lifetimeRevenueSource: priceOnDeclaredFunnel(pre.declared).economics.lifetimeRevenueSource ?? null,
    contactedValueByLead: new Map(contacted.leads.map((l) => [l.leadId, l.expectedValueUsd] as const)),
    statedWonAmountUsdByEmail,
    pricedCauses: ALL_OUTCOME_CAUSES,
  });
}

/**
 * Each organisation's lifecycle rung for the offer (`lib/company-lifecycle.ts`): the offer's lead population (the
 * read `/offers/:offerId/revenue` groups its organisations on) and lead-service's Unibox lifecycle on EVERY rung, Lead
 * found included. Nothing is priced. Both reads fail loud: a missing page would mis-rank an organisation.
 */
export async function computeOfferCompanyLifecycle(
  brandId: string,
  headers: DownstreamHeaders,
  campaignIds: string[],
): Promise<CompanyLifecycleResult> {
  const [persons, rows] = await Promise.all([
    fetchLeadsForRevenue(brandId, campaignIds, headers),
    fetchUniboxLifecycleRows(brandId, LIFECYCLE_RUNGS.map((r) => r.key), headers),
  ]);
  return companyLifecycles({
    persons: dedupPersonsByLead(persons).map((p) => ({ leadId: p.leadId, orgId: p.orgId })),
    rows: rows.map((r) => ({ leadIds: r.leadIds, rung: r.rung })),
  });
}

class CampaignNotOnOfferError extends Error {
  constructor(readonly offerId: string, readonly campaignId: string) {
    super(`Campaign ${campaignId} does not sell offer ${offerId}`);
  }
}

/**
 * `?campaignId=` on the lifecycle board: a pipe campaign of the offer, or a sales funnel campaign of it (campaign-
 * service's, folding its unit campaigns). Either way only the offer's own campaigns; anything else is a named 404.
 */
async function campaignScope(offerId: string, brandId: string, campaignId: string, offerCampaignIds: string[], headers: DownstreamHeaders): Promise<string[]> {
  if (offerCampaignIds.includes(campaignId)) return [campaignId];
  const funnels = await fetchSalesFunnelCampaigns(brandId, offerId, headers);
  const offerSet = new Set(offerCampaignIds);
  const units = funnels.find((f) => f.id === campaignId)?.units.map((u) => u.campaignId).filter((id) => offerSet.has(id)) ?? [];
  if (units.length === 0) throw new CampaignNotOnOfferError(offerId, campaignId);
  return [...new Set(units)].sort();
}

router.get("/offers/:offerId/deals-value", apiKeyAuth, async (req, res) => {
  const columns = req.query.columns === undefined ? "standing" : req.query.columns;
  if (columns !== "standing" && columns !== "lifecycle" && columns !== "company_lifecycle") {
    return res.status(400).json({ error: "columns must be one of: standing, lifecycle, company_lifecycle" });
  }
  const rawCampaignId = typeof req.query.campaignId === "string" ? req.query.campaignId.trim() : "";
  if (req.query.campaignId !== undefined && (columns !== "lifecycle" || rawCampaignId === "")) {
    return res.status(400).json({ error: "campaignId is a non-empty id, read only with columns=lifecycle" });
  }
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, headers, channels, campaignIds, featureSlugs } = resolved;
    if (columns === "company_lifecycle") {
      // Nothing is priced, so no pricing read; the brand must still be the caller's.
      await assertBrandHeld(brandId, headers);
      const result = await servedCached<CompanyLifecycleResult>({
        view: "offer-company-lifecycle",
        scopeKey: buildScopeKey(offerId, {
          orgId: headers.orgId,
          brandId,
          channels: featureSlugs.join("+"),
          campaigns: campaignSetKey(campaignIds),
          m: "company-lifecycle-v1",
        }),
        orgId: headers.orgId,
        compute: () => computeOfferCompanyLifecycle(brandId, headers, campaignIds),
      });
      return res.json({ offerId, brandId, ...result });
    }
    const { pre, keyParts } = await offerPricing(offerId, brandId, headers, channels);
    if (columns === "lifecycle") {
      const scoped = rawCampaignId ? await campaignScope(offerId, brandId, rawCampaignId, campaignIds, headers) : campaignIds;
      const result = await servedCached<DealsLifecycleResult>({
        view: "offer-deals-lifecycle",
        scopeKey: buildScopeKey(offerId, {
          orgId: headers.orgId,
          brandId,
          channels: featureSlugs.join("+"),
          campaigns: campaignSetKey(scoped),
          ...keyParts,
          m: "deals-lifecycle-v1",
        }),
        orgId: headers.orgId,
        compute: () => computeOfferDealsLifecycle(brandId, headers, pre, scoped, offerId),
      });
      return res.json({ offerId, brandId, campaignId: rawCampaignId || null, ...result });
    }
    const result = await servedCached<DealsValueResult>({
      view: "offer-deals-value",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        channels: featureSlugs.join("+"),
        campaigns: campaignSetKey(campaignIds),
        ...keyParts,
        m: "deals-value-v4",
      }),
      orgId: headers.orgId,
      compute: () => computeBrandDealsValue(brandId, headers, pre, campaignIds, offerId),
    });
    return res.json({ offerId, brandId, ...result });
  } catch (error) {
    return offerError(res, error, "deals value");
  }
});

router.get("/offers/:offerId/contacted-value", apiKeyAuth, async (req, res) => {
  const page = parseContactedValuePage(req.query as Record<string, unknown>);
  if ("error" in page) return res.status(400).json({ error: page.error });
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, headers, channels, campaignIds, featureSlugs } = resolved;
    const { pre, keyParts } = await offerPricing(offerId, brandId, headers, channels);
    const result = await servedCached<OfferContactedValueResult>({
      view: "offer-contacted-value",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        channels: featureSlugs.join("+"),
        campaigns: campaignSetKey(campaignIds),
        ...keyParts,
        m: "contacted-value-v5",
      }),
      orgId: headers.orgId,
      compute: () => computeOfferContactedValue(brandId, headers, pre, campaignIds, offerId),
    });
    return res.json({ offerId, brandId, ...pageContactedValue(result, page) });
  } catch (error) {
    return offerError(res, error, "contacted value");
  }
});

export default router;
