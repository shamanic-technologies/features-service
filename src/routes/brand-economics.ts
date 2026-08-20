/**
 * WHAT A BRAND RETURNED — across every acquisition channel it runs, in ONE request.
 *
 * A brand holds several OFFERS and sells each of them through several CHANNELS. A channel is a feature
 * slug (this fleet has no other name for one), each is funded and paced on its own money, and each runs
 * its own campaigns. Every read this service serves names ONE feature slug in its path or resolves the
 * channels of ONE offer, so neither can answer for the brand — and the brand is what its own Overview
 * presents.
 *
 *   GET /brands/:brandId/revenue            — the brand's money, plus a per-channel breakdown
 *   GET /brands/:brandId/audience-stats     — the brand's per-audience economics across its channels
 *   GET /brands/:brandId/pipeline-activity  — the brand's per-day activity across its channels
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────────────────────────
 *
 * The Overview read one channel's money and paired it with billing's BRAND daily budget, making a
 * fraction with two grains in it. Prod 2026-08-20, brand `75d7e3e8…`: the pitch channel spent $40.07
 * today against its own $40 ceiling and the feedback-request channel $10.32 against its own $10, and
 * the page read "$40 / 50". The denominator was right, the numerator was about one channel, and
 * nothing errored — both numbers were real, they were simply about different things.
 *
 * ── WHICH FIGURES ADD, AND WHICH DO NOT ─────────────────────────────────────────────────────────
 *
 * Identical to the offer grain, and DELIBERATELY the same code rather than the same rules restated —
 * see the header of `offer-economics.ts` for the full statement. In one line each:
 *
 *   ADDITIVE — MONEY, and only money. A run carries exactly one `feature_slug`, so the channel set is
 *   handed to runs-service as its plural `featureSlugs` filter and the PRODUCER does the summing over
 *   the same rows it would have returned per channel. Same for run counts and for any per-day SEND.
 *
 *   NOT ADDITIVE — PEOPLE. A lead worked through two channels is ONE lead to the brand. The lead read
 *   has never been feature-scoped, so one brand-scoped read already covers every channel and
 *   `dedupPersonsByLead` collapses the duplicate before the engine sees it.
 *
 *   NOT ADDITIVE — PIPELINE. The engine combines a lead's paths per ORGANISATION, which is not
 *   additive across partitions. ONE engine pass over the brand's whole evidence set, never N combined.
 *
 *   NOT ADDITIVE — EVERY RATIO. A ratio of sums is neither the sum nor the average of the ratios; each
 *   is recomputed from the combined numerator and denominator, which the single pass already does.
 *
 *   NOT COMBINABLE AT ALL — A BENCHMARK. It is a property of ONE channel, so the BEST-RETURNING
 *   channel's is taken whole (`pickBestChannel`), never blended.
 *
 * ── WHY THIS IS NOT THE SUM OF THE BRAND'S OFFERS, NOR OF ITS CHANNELS ──────────────────────────
 *
 * Only the additive half could be summed at all, and even that would be assembled in a browser that
 * does not own the list of offers or channels. Everything else — the people, the pipeline, every ratio,
 * the benchmark — would be wrong in a way no consumer could detect. So the brand's answer is computed
 * at the brand's own grain, off the brand's own evidence, exactly once.
 *
 * ── THE SCOPE IS THE CHANNEL SET, NOT AN ENUMERATED CAMPAIGN LIST ───────────────────────────────
 *
 * `brandId` is already a producer filter on every read here, so unlike the offer grain (where the
 * campaign is the frozen link to the offer) nothing is narrowed by campaign. Two consequences, both
 * wanted: a campaign campaign-service does not list still has its spend counted, and a brand running
 * exactly ONE channel issues the byte-same downstream requests its per-feature read issues today — so
 * its answer cannot move. See `lib/brand-channels.ts`.
 *
 * ── A CHANNEL THIS SERVICE CANNOT MEASURE STILL COSTS MONEY ─────────────────────────────────────
 *
 * Several published channels declare no funnel (this service measures email today). Their campaigns
 * are in the brand's scope all the same, so their SPEND counts — the customer paid it — while they
 * contribute no pipeline, exactly as their own per-feature read reports them. The breakdown shows each
 * with real spend and a null pipeline, so the caveat is visible rather than buried in the total.
 *
 * ── WHAT IS NOT SERVED AT THIS GRAIN ────────────────────────────────────────────────────────────
 *
 * `?lens=` (a lens narrows to a subset of LEADS while its spend leg would still be the whole brand's)
 * and `?groupBy=` (the only grouping here is the channel breakdown, which is unconditional). Both stay
 * available per channel on the existing reads, which are untouched and still mean what they mean.
 */
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { getFunnel } from "../lib/funnel-registry.js";
import {
  computeFeatureRevenue,
  fetchDeclaredFunnelsSoft,
  priceOnDeclaredFunnel,
  type DownstreamHeaders,
  type FunnelPricedEconomics,
} from "./revenue.js";
import { distinctChannelFunnels } from "./offer-economics.js";
import { computeAudienceStats, type ComputeResult } from "../lib/audience-stats-compute.js";
import { computeBrandPipelineActivity } from "./pipeline-activity.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { matchSalesFunnelKey, SALES_FUNNEL_KEYS, type SalesFunnelKey } from "../lib/sales-funnels.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import {
  resolveBrandChannels,
  brandFeatureSlugs,
  BrandHasNoChannelsError,
  type BrandChannel,
} from "../lib/brand-channels.js";

const router = Router();

/**
 * The brand's channels price on more than one funnel definition, so its money cannot be one figure.
 *
 * The registry maps a slug to a funnel, and two channels pointing at different definitions would price
 * the same lead two ways in a single engine pass — which cannot be done honestly. It cannot happen
 * today (every registered channel prices on the one sales funnel), and if it ever does the read says
 * so rather than picking one. The offer grain answers the identical case the identical way.
 */
export class BrandChannelsPriceDifferentlyError extends Error {
  constructor(readonly brandId: string) {
    super(
      `brand ${brandId} runs channels that price on different funnels, so its money cannot be answered as one figure`,
    );
    this.name = "BrandChannelsPriceDifferentlyError";
  }
}

function resolveBrandFunnel(brandId: string, channels: BrandChannel[]): ReturnType<typeof getFunnel> {
  const distinct = distinctChannelFunnels(channels);
  if (distinct.length > 1) throw new BrandChannelsPriceDifferentlyError(brandId);
  return distinct[0] ?? null;
}

/** Shared parsing + channel resolution for all three brand reads. */
async function resolveRequest(req: AuthenticatedRequest & { params: { brandId: string }; query: Record<string, unknown> }) {
  const brandId = req.params.brandId;

  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) return { ok: false as const, status: 400, error: "pricing must be one of: gross, net" };

  const channels = await resolveBrandChannels(brandId, { orgId: req.orgId, userId: req.userId, runId: req.runId });
  const featureSlugs = brandFeatureSlugs(channels);
  const headers: DownstreamHeaders = {
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
    // Named only when the brand runs exactly ONE channel. Attributing a several-channel read to one of
    // them would name a channel the caller never asked about — and it is what keeps the one-channel
    // case byte-identical to that channel's own read.
    featureSlug: featureSlugs.length === 1 ? featureSlugs[0] : undefined,
  };
  return { ok: true as const, brandId, pricing, headers, channels, featureSlugs };
}

/** The `channels` key every brand response carries — what was combined, always, even when it is one. */
function describeChannels(channels: BrandChannel[]) {
  return channels.map((channel) => ({ featureSlug: channel.featureSlug, campaignIds: channel.campaignIds }));
}

/** Named 404 / 409 / 502, shared by the three handlers. */
function handleError(res: import("express").Response, error: unknown, what: string) {
  if (error instanceof BrandHasNoChannelsError) {
    return res.status(404).json({ error: error.message, reason: "brand_has_no_channels", brandId: error.brandId });
  }
  if (error instanceof BrandChannelsPriceDifferentlyError) {
    return res.status(409).json({ error: error.message, reason: "brand_channels_price_differently", brandId: error.brandId });
  }
  console.error(`[features-service] Brand ${what} error:`, error);
  return res.status(502).json({ error: `Failed to compute brand ${what}` });
}

// ── GET /brands/:brandId/revenue ─────────────────────────────────────────────
//
// The brand's own money — pipeline, return, cost of acquisition, spend — plus one LEAN group per
// channel beside it, so a channel row and the brand total above it are one statement at two grains and
// a caller never has to reconcile two numbers.
//
// MONEY is what the rows are comparable on, and Σ rows IS the brand's spend — not to the cent, and for
// the reason the workflow and offer grains already document: a channel row reads its spend grouped by
// workflow while the brand body builds its `spend` block grouped by cost name, and runs-service returns
// FRACTIONAL cents per group, so each rounds once per its own grouping. Same ledger, different
// grouping — do NOT "fix" it by re-basing either side. The PEOPLE half does not sum, for the reason
// stated at the row itself.
router.get("/brands/:brandId/revenue", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { brandId, pricing, headers, channels, featureSlugs } = resolved;

    // `?funnel=` names the SALES FUNNEL the spend block's cost-per-outcome columns are priced on, with
    // the same meaning and the same fail-loud parse as the per-feature read.
    let requestedFunnel: SalesFunnelKey | undefined;
    const funnelParam = req.query.funnel as string | undefined;
    if (funnelParam) {
      const matched = matchSalesFunnelKey(funnelParam);
      if (!matched) return res.status(400).json({ error: `funnel must be one of: ${SALES_FUNNEL_KEYS.join(", ")}` });
      requestedFunnel = matched;
    }

    const funnel = resolveBrandFunnel(brandId, channels);

    // Economics are BRAND-scoped, so they are read ONCE here and shared by the brand body and every
    // channel group: N channels cost one brand-service call, and the fingerprint rides the cache key so
    // an economics write lands on a different cell instead of replaying the pre-write answer.
    const [declaredFunnels, brandEconomics] = funnel
      ? await Promise.all([fetchDeclaredFunnelsSoft(brandId, headers.orgId), fetchEffectiveEconomics(brandId, headers)])
      : [[], null];
    const brandPriced: FunnelPricedEconomics | undefined = brandEconomics
      ? priceOnDeclaredFunnel(declaredFunnels, brandEconomics, requestedFunnel)
      : undefined;
    const econ = brandPriced ? economicsFingerprint(brandPriced.economics) : undefined;
    const decl = funnel ? declaredFunnels.map((f) => f.funnelKey).sort().join("+") || "none" : undefined;

    const payload = await servedCached({
      view: "brand-revenue",
      // Keyed on the brand AND on the CHANNEL SET: a newly funded channel changes every figure while no
      // other key part moves, so without it the brand would keep replaying its pre-funding answer.
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: featureSlugs.join("+"),
        funnel: requestedFunnel,
        decl,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      compute: async () => {
        // ONE engine pass over the brand's whole evidence set, with NO campaign narrowing.
        const body = await computeFeatureRevenue(
          featureSlugs,
          brandId,
          undefined,
          funnel,
          headers,
          undefined,
          brandPriced,
          true,
          pricing,
          requestedFunnel,
        );
        // The breakdown. LEAN on purpose (headline + costEconomics, the shape the offer and workflow
        // groups already use): a full body per channel would repeat the whole lead population once per
        // channel for figures the brand body already carries.
        //
        // A row IS narrowed to its channel's campaigns, unlike the brand body above. The row's money
        // would be identical either way (the feature filter already isolates a channel's cost rows),
        // but its PIPELINE would not: a per-feature read prices the brand's WHOLE lead population — the
        // lead read has never been feature-scoped — so an un-narrowed row would divide the brand's
        // pipeline by one channel's spend and print a return that channel never earned. Narrowing to
        // its own campaigns is what makes a row's return its own. The rows therefore do NOT sum to the
        // brand: a lead worked through two channels is one lead to the brand and belongs to both rows,
        // and a lead on a campaign campaign-service does not list is in no row (its money still counts
        // in the total above, which narrows by nothing).
        const groups = await mapWithConcurrency(channels, 4, async (channel) => {
          const channelBody = await computeFeatureRevenue(
            channel.featureSlug,
            brandId,
            // `[]` reads as "no filter" everywhere downstream, so a channel campaign-service lists no
            // campaign for stays brand-wide rather than silently scoping to nothing.
            channel.campaignIds.length > 0 ? channel.campaignIds : undefined,
            getFunnel(channel.featureSlug),
            headers,
            undefined,
            brandPriced,
            false,
            pricing,
            requestedFunnel,
          );
          return {
            featureSlug: channel.featureSlug,
            campaignIds: channel.campaignIds,
            headline: channelBody.headline,
            costEconomics: channelBody.costEconomics,
          };
        });
        return { brandId, channels: groups, ...body };
      },
    });

    res.json(payload);
  } catch (error) {
    return handleError(res, error, "revenue");
  }
});

// ── GET /brands/:brandId/audience-stats ──────────────────────────────────────
//
// The brand's per-audience economics, across every channel. Audiences are BRAND entities (human-service
// owns them), so the audience LIST is unchanged; what widens is the money and the engagement behind
// each row — both per-audience send-tag figures, and a send carries exactly one channel, so they add
// with nothing counted twice. The RATIOS on each row are then recomputed from those combined
// numerators, never averaged.
router.get("/brands/:brandId/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { brandId, pricing, headers, channels, featureSlugs } = resolved;

    let econ: string | undefined;
    try {
      econ = economicsFingerprint(await fetchEffectiveEconomics(brandId, headers));
    } catch (err) {
      // Feeds the KEY, not the response — degrading to "no fingerprint" keeps the compute (which reads
      // economics fail-loud) the one that decides this request's status.
      console.warn(`[features-service] brand audience-stats economics fingerprint unavailable: ${(err as Error).message}`);
    }

    // The compute reads the brand from `?brandId=`, which the path already names here.
    (req.query as Record<string, unknown>).brandId = brandId;

    const result = await servedCached<ComputeResult>({
      view: "brand-audience-stats",
      scopeKey: buildScopeKey(brandId, {
        orgId: headers.orgId,
        channels: featureSlugs.join("+"),
        goal: req.query.goal,
        funnel: req.query.funnel,
        statuses: req.query.statuses,
        limit: req.query.limit,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      // No campaign ids: the brand grain narrows on the channel set alone, so each channel is read
      // brand-wide rather than per enumerated campaign.
      compute: () => computeAudienceStats(req, pricing, undefined, channels),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    // `brandId` already rides the envelope with the identical value — stated once.
    res.json({ channels: describeChannels(channels), ...result.envelope });
  } catch (error) {
    return handleError(res, error, "audience stats");
  }
});

// ── GET /brands/:brandId/pipeline-activity ───────────────────────────────────
//
// The brand's per-day activity, across every channel. Every series is an EVENT count tagged to one
// campaign, and a campaign runs through one channel, so the channels add exactly.
//
// Unlike the offer grain, the DAILY BUDGET and the OBSERVED conversions ARE this grain's own figures —
// billing funds the budget per brand and the conversion tracker is brand-keyed — so both are stated
// rather than nulled. The FORECAST is not combinable across channels (its divisor is one channel's cost
// per outreach and there is no per-channel ceiling to split the budget by), so with several channels it
// is null; with exactly one it is computed, unchanged. See `computeBrandPipelineActivity`.
router.get("/brands/:brandId/pipeline-activity", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { brandId, pricing, headers, channels } = resolved;

    const payload = await computeBrandPipelineActivity(req as never, {
      brandId,
      pricing,
      channels,
      headers: { orgId: headers.orgId, userId: headers.userId ?? "", runId: headers.runId ?? "" },
    });
    if (!payload.ok) return res.status(payload.status).json(payload.body);
    res.json({ channels: describeChannels(channels), ...payload.body });
  } catch (error) {
    return handleError(res, error, "pipeline activity");
  }
});

export default router;
