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
import { servedCachedJson, sendSnapshotJson, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { DEFAULT_PRICED_CAUSES } from "../lib/outcome-cause.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { stepValues } from "../lib/offer-outcomes.js";
import { SEED_FEATURES } from "../seed/features.js";
import { SOURCING_ORIGINS, SOURCING_PARENT_CHANNEL_SLUGS } from "../lib/sourcing-origins.js";
import {
  computeOfferSourcing,
  fetchAudienceListKinds,
  fetchCampaignTotalCents,
  fetchOfferServeCosts,
  type SourcedLead,
} from "../lib/offer-sourcing.js";

const router = Router();

const featureName = new Map(SEED_FEATURES.map((f) => [f.slug, f.name] as const));

export const OFFER_SOURCING_DEFINITION = {
  basis: "committed",
  window: "since_inception",
  campaignTotal: "committed spend of the campaign's runs on its channel slug and every sourcing origin slug (the figure the campaign's outcome reads print)",
  sourcing: "the whole cost subtree of every lead-service lead-serve run of the campaign (screening, reveal, enrichment, email finding and verification)",
  outreach: "campaign total minus sourcing, exact",
  outreachAllocation: "per origin, each campaign's outreach is shared over its origins by the leads it served from each",
  notCounted: ["audience list building (apollo-service audience-companies): it belongs to no campaign"],
} as const;

router.get("/public/sourcing-origins", (_req, res) => {
  res.json({
    origins: SOURCING_ORIGINS.map((o) => ({
      slug: o.slug,
      name: o.name,
      description: o.description,
      family: o.family,
      audienceLists: [...o.audienceLists],
      live: o.live,
      displayOrder: o.displayOrder,
    })),
    sourcingChannels: [...SOURCING_PARENT_CHANNEL_SLUGS],
  });
});

router.get("/offers/:offerId/sourcing", apiKeyAuth, async (rawReq, res) => {
  try {
    const req = rawReq as AuthenticatedRequest;
    const offerId = req.params.offerId as string;
    const brandId = (req.query.brandId as string | undefined) ?? "";
    if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return res.status(400).json({ error: "pricing must be one of: gross, net" });

    const identity = { orgId: req.orgId, userId: req.userId, runId: req.runId };
    const headers: DownstreamHeaders = { ...identity, featureSlug: undefined };
    const rows = await fetchBrandCampaignRows(brandId, undefined, identity);
    const campaigns = rows
      .filter((r) => r.id && r.offerId === offerId && r.featureSlug && SOURCING_PARENT_CHANNEL_SLUGS.includes(r.featureSlug))
      .map((r) => ({
        id: r.id,
        featureSlug: r.featureSlug!,
        channelName: featureName.get(r.featureSlug!) ?? r.featureSlug!,
        legKey: r.legKey ?? null,
        status: r.status ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const [declared] = await Promise.all([fetchDeclaredFunnelsSoft(brandId, req.orgId, offerId), assertBrandHeld(brandId, headers)]);

    const payload = await servedCachedJson({
      view: "offer-sourcing",
      scopeKey: buildScopeKey(offerId, {
        orgId: req.orgId,
        brandId,
        campaigns: campaigns.map((c) => c.id).join("+"),
        decl: declared.map((f) => f.funnelKey).sort().join("+") || "none",
        econ: pricedFingerprint(priceOnDeclaredFunnel(declared)),
        pricing,
      }),
      orgId: req.orgId,
      compute: async () => {
        const campaignIds = campaigns.map((c) => c.id);
        const channelSlugs = [...new Set(campaigns.map((c) => c.featureSlug))];
        // Serves FIRST, campaign total second: a cost written between the two lands in the campaign total (outreach).
        const [serves, listOfAudience, people] = await Promise.all([
          fetchOfferServeCosts(brandId, campaignIds, identity, pricing),
          fetchAudienceListKinds(brandId, identity),
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
        };
      },
    });
    sendSnapshotJson(res, payload);
  } catch (error) {
    if (error instanceof BrandOwnershipError) return res.status(404).json({ error: "Brand not found", reason: "brand_not_found" });
    console.error("[features-service] Offer sourcing error:", error);
    res.status(502).json({ error: "Failed to compute offer sourcing" });
  }
});

export default router;
