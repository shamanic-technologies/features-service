/**
 * SOURCING SPLIT (requested 2026-10-07): where an offer's leads come from, what each source cost and paid
 * back, and per campaign "[sourcing] -> [outreach channel]" with each half's share of its cost.
 * The rules live in `lib/sourcing-origins.ts` (catalogue + transition) and `lib/offer-sourcing.ts` (money).
 *
 *   GET /public/sourcing-origins          every origin a lead can come from (no identity)
 *   GET /offers/:offerId/sourcing         per origin (used AND unused) + per campaign sourcing + outreach split, since inception
 *
 * ADDITIVE: no existing read moves. The campaign total served here is the same committed campaign spend the
 * outcome reads print, so a dashboard showing sourcing + outreach shows today's figure split in two.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { fetchDeclaredFunnelsSoft, priceOnDeclaredFunnel, pricedFingerprint, type DownstreamHeaders } from "./revenue.js";
import { readOfferPersons } from "./offer-outcomes.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { servedCached, servedCachedJson, sendSnapshotJson, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { DEFAULT_PRICED_CAUSES } from "../lib/outcome-cause.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { stepValues } from "../lib/offer-outcomes.js";
import { SEED_FEATURES } from "../seed/features.js";
import {
  LEAD_FOUND_STEP,
  SOURCE_LEG_KEY,
  SOURCING_ORIGINS,
  SOURCING_ORIGIN_SLUGS,
  SOURCING_ORIGINS_BY_CHANNEL,
  SOURCING_PARENT_CHANNEL_SLUGS,
  sourceCampaignKeyOf,
} from "../lib/sourcing-origins.js";
import { buildOutreachCampaignSplits } from "../lib/source-campaigns.js";
import {
  computeOfferSourcing,
  fetchAudienceListKinds,
  fetchCampaignTotalCents,
  fetchOfferServeCosts,
  fetchUnrecordedCostEvidence,
  unrecordedOriginsByCampaign,
  type OfferSourcing,
  type SourcedLead,
} from "../lib/offer-sourcing.js";
import type { Pricing } from "../lib/pricing.js";

const router = Router();

const featureName = new Map(SEED_FEATURES.map((f) => [f.slug, f.name] as const));

export const OFFER_SOURCING_DEFINITION = {
  basis: "committed",
  window: "since_inception",
  campaignTotal: "committed spend of the campaign's runs on its channel slug and every sourcing origin slug (the figure the campaign's outcome reads print)",
  sourcing: "the whole cost subtree of every lead-service lead-serve run of the campaign (screening, reveal, enrichment, email finding and verification)",
  outreach: "campaign total minus sourcing, exact",
  outreachAllocation: "per origin, each campaign's outreach is shared over its origins by the leads it served from each",
  unrecordedOrigin:
    "a serve or lead that recorded no audience counts under the origin its campaign is proven to source from: a channel serving from one origin only (CRM email), else the lead-provider costs its audience-less runs bought (Apollo only, all before Apollo Buying Signals existed on 2026-10-02 -> Apollo Cold Filters; Apify search only -> Apify Search); otherwise unattributed",
  notCounted: ["audience list building (apollo-service audience-companies): it belongs to no campaign"],
} as const;

router.get("/public/sourcing-origins", (_req, res) => {
  res.json({
    origins: SOURCING_ORIGINS.map((o) => ({
      slug: o.slug,
      name: o.name,
      description: o.description,
      family: o.family,
      provider: o.provider,
      audienceLists: [...o.audienceLists],
      live: o.live,
      displayOrder: o.displayOrder,
      sourceCampaignKey: sourceCampaignKeyOf(o.slug),
    })),
    leadFoundStep: { ...LEAD_FOUND_STEP },
    sourceLegKey: SOURCE_LEG_KEY,
    sourcingChannels: [...SOURCING_PARENT_CHANNEL_SLUGS],
    originsByChannel: Object.fromEntries(SOURCING_PARENT_CHANNEL_SLUGS.map((c) => [c, [...SOURCING_ORIGINS_BY_CHANNEL[c]!]])),
  });
});

/** The offer-sourcing payload as served: the per-origin, per-campaign split + the source-campaign re-cut. */
export type OfferSourcingPayload = OfferSourcing & {
  offerId: string;
  brandId: string;
  pricing: Pricing;
  definition: typeof OFFER_SOURCING_DEFINITION;
  valuePerPositiveReplyUsd: number | null;
  outreachCampaigns: ReturnType<typeof buildOutreachCampaignSplits>;
};

/**
 * The Gold cell of `/offers/:id/sourcing` (one per org × brand × offer × campaigns × declared funnels ×
 * pricing). Shared by the route and by `/offers/:id/sales-paths` (its source campaigns), so both read the
 * SAME figures. Throws `BrandOwnershipError` when the brand is not held; any other failure throws.
 */
export async function offerSourcingCell(input: {
  offerId: string;
  brandId: string;
  pricing: Pricing;
  identity: { orgId: string; userId?: string; runId?: string };
}) {
  const { offerId, brandId, pricing, identity } = input;
  const headers: DownstreamHeaders = { ...identity, featureSlug: undefined };
  const rows = await fetchBrandCampaignRows(brandId, undefined, identity);
  // The offer's campaigns on a channel that sources leads, AND its source campaigns (featureSlug = an origin).
  const campaigns = rows
    .filter(
      (r) =>
        r.id &&
        r.offerId === offerId &&
        r.featureSlug &&
        (SOURCING_PARENT_CHANNEL_SLUGS.includes(r.featureSlug) || SOURCING_ORIGIN_SLUGS.includes(r.featureSlug)),
    )
    .map((r) => ({
      id: r.id,
      featureSlug: r.featureSlug!,
      channelName: featureName.get(r.featureSlug!) ?? r.featureSlug!,
      legKey: r.legKey ?? null,
      status: r.status ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const [declared] = await Promise.all([fetchDeclaredFunnelsSoft(brandId, identity.orgId, offerId), assertBrandHeld(brandId, headers)]);

  return {
    view: "offer-sourcing",
    scopeKey: buildScopeKey(offerId, {
      orgId: identity.orgId,
      brandId,
      campaigns: campaigns.map((c) => c.id).join("+"),
      decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
      econ: pricedFingerprint(priceOnDeclaredFunnel(declared)),
      pricing,
    }),
    orgId: identity.orgId,
    compute: async (): Promise<OfferSourcingPayload> => {
      const campaignIds = campaigns.map((c) => c.id);
      const channelSlugs = [...new Set(campaigns.map((c) => c.featureSlug))];
      // Serves FIRST, campaign total second: a cost written between the two lands in the campaign total (outreach).
      const [serves, listOfAudience, unrecordedEvidence, people] = await Promise.all([
        fetchOfferServeCosts(brandId, campaignIds, identity, pricing),
        fetchAudienceListKinds(brandId, identity),
        fetchUnrecordedCostEvidence(brandId, campaignIds, channelSlugs, identity),
        campaignIds.length > 0
          ? readOfferPersons({
              brandId,
              campaignIds,
              headers,
              pricedFunnelKeys: declared.map((f) => f.funnelKey),
              causes: DEFAULT_PRICED_CAUSES,
              needDates: false,
            })
          : Promise.resolve({ persons: [] }),
      ]);
      const totalCentsByCampaign = await fetchCampaignTotalCents(brandId, campaignIds, channelSlugs, identity, pricing);
      const leads: SourcedLead[] = people.persons.map((p) => ({
        leadId: p.leadId,
        campaignId: p.campaignId ?? null,
        audienceId: p.audienceId ?? null,
        positiveReply: p.signals.positiveReply === true,
      }));
      const value = stepValues(declared).get("conversation")?.valuePerOutcomeUsd ?? null;
      const result = computeOfferSourcing({
        campaigns,
        serves,
        totalCentsByCampaign,
        listOfAudience,
        unrecordedOriginByCampaign: unrecordedOriginsByCampaign(campaigns, unrecordedEvidence),
        leads,
        valuePerPositiveReplyUsd: value,
      });
      return {
        offerId,
        brandId,
        pricing,
        definition: OFFER_SOURCING_DEFINITION,
        valuePerPositiveReplyUsd: value,
        ...result,
        outreachCampaigns: buildOutreachCampaignSplits(result),
      };
    },
  };
}

/** The same cell as the route, as a VALUE (for an in-process reader). */
export async function readOfferSourcing(input: Parameters<typeof offerSourcingCell>[0]): Promise<OfferSourcingPayload> {
  return servedCached(await offerSourcingCell(input));
}

router.get("/offers/:offerId/sourcing", apiKeyAuth, async (rawReq, res) => {
  try {
    const req = rawReq as AuthenticatedRequest;
    const offerId = req.params.offerId as string;
    const brandId = (req.query.brandId as string | undefined) ?? "";
    if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return res.status(400).json({ error: "pricing must be one of: gross, net" });
    const identity = { orgId: req.orgId, userId: req.userId, runId: req.runId };
    const payload = await servedCachedJson(await offerSourcingCell({ offerId, brandId, pricing, identity }));
    sendSnapshotJson(res, payload);
  } catch (error) {
    if (error instanceof BrandOwnershipError) return res.status(404).json({ error: "Brand not found", reason: "brand_not_found" });
    console.error("[features-service] Offer sourcing error:", error);
    res.status(502).json({ error: "Failed to compute offer sourcing" });
  }
});

export default router;
