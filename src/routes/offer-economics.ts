/**
 * WHAT AN OFFER RETURNED — across every acquisition channel it is sold through, in ONE request.
 *
 * A brand sells one OFFER through several CHANNELS at once. A channel is a feature slug (this fleet
 * has no other name for one), each is funded and paced on its own money, each runs its own campaigns
 * against the same offer, the same funnel and the same audiences — and the customer looks at the offer
 * as one thing. Every read this service already serves names ONE feature slug in its path, so each one
 * answers "what did this offer return THROUGH THIS ONE CHANNEL" while an offer screen presents it as
 * what the offer returned. While a brand had one channel those were the same answer. They are not any
 * more, and the divergence is silent: nothing errors, the figures are simply about less than they claim.
 *
 * These three reads answer at the OFFER grain instead. The per-feature reads are untouched and keep
 * meaning exactly what they mean — a campaign row IS a channel, priced on its own channel's money.
 *
 *   GET /offers/:offerId/revenue            — the offer's money, plus a per-channel breakdown
 *   GET /offers/:offerId/audience-stats     — the offer's per-audience economics
 *   GET /offers/:offerId/pipeline-activity  — the offer's per-day activity
 *
 * ── WHICH FIGURES ADD, AND WHICH DO NOT ─────────────────────────────────────────────────────────
 *
 * The answer is NOT assembled by summing per-channel results, because most of it does not sum. What
 * combines how, and how each is actually handled here:
 *
 *   ADDITIVE — MONEY, and only money. A run carries exactly one `feature_slug` and exactly one
 *   `campaign_id`, so every cost row belongs to exactly one channel of one offer. Spend across
 *   channels therefore adds with nothing counted twice — and it is not even added HERE: the offer's
 *   feature scope is handed to runs-service as its plural `featureSlugs` filter, so the producer does
 *   the summing over the same rows it would have returned per channel. Same for run counts and for
 *   any per-day SEND count (a send is tagged to one campaign).
 *
 *   NOT ADDITIVE — PEOPLE. A lead worked through two channels is ONE lead to the offer and belongs to
 *   both. Summing two channels' contacted counts double-counts it; this is the identical property the
 *   per-campaign and per-workflow grains already document, and the same one that makes those groups
 *   not sum to their brand. Handled by never summing: the lead read is brand-scoped and
 *   campaign-filtered (it has never been feature-scoped), so ONE read covers every channel at once
 *   and `dedupPersonsByLead` collapses the duplicate before the engine sees it.
 *
 *   NOT ADDITIVE — PIPELINE. The revenue engine combines a lead's paths per ORGANISATION, and that
 *   combination is not additive across partitions: two channels that each reached one person at the
 *   same company produce less pipeline together than apart. Handled by running the engine ONCE over
 *   the offer's whole evidence set, never once per channel.
 *
 *   NOT ADDITIVE — EVERY RATIO. ROI, %CAC, $CAC, cost per click, cost per reply. A ratio of sums is
 *   not the sum of ratios and it is not their average either. Handled by recomputing each one from the
 *   combined numerator and the combined denominator — which is what the single engine pass already
 *   does, so no ratio is ever touched at the offer level.
 *
 *   NOT COMBINABLE AT ALL — A BENCHMARK. The cross-org best-workflow floor is a property of one
 *   channel. Several channels have several benchmarks and there is no such thing as the benchmark of
 *   a mix; blending two would be the cross-org PLUS cross-workflow pooled estimate this service
 *   refuses to publish. Handled by CHOOSING the best-returning channel's benchmark whole — see
 *   lib/offer-parents.ts.
 *
 * ── A CHANNEL THIS SERVICE CANNOT MEASURE STILL COSTS MONEY ─────────────────────────────────────
 *
 * Several published channels declare no funnel (this service measures email today, and a channel that
 * declared measurements it cannot make would report a fabricated zero). Their campaigns are in the
 * offer's scope all the same, so their SPEND counts — the customer paid it — while they contribute no
 * pipeline, exactly as their own per-feature read reports them. Nothing has to special-case them: the
 * engine prices SIGNALS, and a channel that sends no email produces none. The per-channel breakdown
 * shows each such channel with real spend and a null pipeline, so the caveat is visible rather than
 * buried in the total.
 *
 * ── WHY THE OFFER'S FIGURES ARE NOT ALSO EXPOSED AS N SEPARATE CALLS ────────────────────────────
 *
 * The consumer does not own which channels an offer sells through (the campaign row does, here), and
 * an answer it assembled from N calls would be the browser-side re-derivation this grain exists to
 * prevent. So the channel list is resolved here and the breakdown ships in the SAME response as the
 * total: a row for one channel and the total above it are visibly one statement at two grains.
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
import { computeAudienceStats, type ComputeResult } from "../lib/audience-stats-compute.js";
import { computeOfferPipelineActivity } from "./pipeline-activity.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing } from "../lib/pricing.js";
import { matchSalesFunnelKey, SALES_FUNNEL_KEYS, type SalesFunnelKey } from "../lib/sales-funnels.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import {
  resolveOfferChannels,
  offerCampaignIds,
  offerFeatureSlugs,
  OfferHasNoChannelsError,
  type OfferChannel,
} from "../lib/offer-channels.js";

const router = Router();

/**
 * The funnel an offer's money is priced through.
 *
 * Every channel that HAS a funnel must share it — the registry maps a slug to a funnel definition, and
 * two channels pointing at different definitions would price the same lead two ways in one pass, which
 * cannot be done honestly. It cannot happen today (every registered channel prices on the one sales
 * funnel), and if it ever does the read says so rather than picking one.
 *
 * `null` when NO channel of the offer has a funnel: the offer reports its spend with a null pipeline,
 * the same answer each of those channels gives on its own.
 */
export class OfferChannelsPriceDifferentlyError extends Error {
  constructor(readonly offerId: string) {
    super(
      `offer ${offerId} is sold through channels that price on different funnels, so its money cannot be answered as one figure`,
    );
    this.name = "OfferChannelsPriceDifferentlyError";
  }
}

/**
 * The DISTINCT funnel definitions a set of channels prices on.
 *
 * Shared with the brand grain, which faces the identical question one narrowing wider: a read spanning
 * several channels can be priced as one figure only when they price one way. More than one entry means
 * the caller must be told rather than have one silently picked; an empty one means no channel of the
 * set has a funnel, and the read reports spend with a null pipeline — the same answer each of those
 * channels gives on its own.
 */
export function distinctChannelFunnels(
  channels: Array<{ featureSlug: string }>,
): Array<NonNullable<ReturnType<typeof getFunnel>>> {
  return [...new Set(channels.map((c) => getFunnel(c.featureSlug)).filter((f) => f !== null))];
}

/**
 * The one funnel an offer's channels price on, or null when none of them has one.
 *
 * Exported because the BRAND grain asks the identical question once per offer when it breaks a brand
 * down into its offers — the same rule answered by the same code, never restated.
 */
export function resolveOfferFunnel(offerId: string, channels: OfferChannel[]): ReturnType<typeof getFunnel> {
  const distinct = distinctChannelFunnels(channels);
  if (distinct.length > 1) throw new OfferChannelsPriceDifferentlyError(offerId);
  return distinct[0] ?? null;
}

/** Shared parsing + channel resolution for all three offer reads. */
async function resolveRequest(req: AuthenticatedRequest & { params: { offerId: string }; query: Record<string, unknown> }) {
  const offerId = req.params.offerId;
  const brandId = (req.query.brandId as string | undefined) ?? "";
  if (!brandId) return { ok: false as const, status: 400, error: "brandId query parameter is required" };

  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) return { ok: false as const, status: 400, error: "pricing must be one of: gross, net" };

  const headers: DownstreamHeaders = {
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
    // Deliberately NOT the request's own `x-feature-slug`: this read is about several channels, and
    // attributing it to one of them would name a channel the caller did not ask about.
    featureSlug: undefined,
  };
  const channels = await resolveOfferChannels(offerId, brandId, { orgId: req.orgId, userId: req.userId, runId: req.runId });
  return {
    ok: true as const,
    offerId,
    brandId,
    pricing,
    headers,
    channels,
    campaignIds: offerCampaignIds(channels),
    featureSlugs: offerFeatureSlugs(channels),
  };
}

/** The `channels` key every offer response carries — what was combined, always, even when it is one. */
function describeChannels(channels: OfferChannel[]) {
  return channels.map((channel) => ({ featureSlug: channel.featureSlug, campaignIds: channel.campaignIds }));
}

// ── GET /offers/:offerId/revenue ─────────────────────────────────────────────
//
// The offer's own money — pipeline, return, cost of acquisition, spend — plus one LEAN group per
// channel beside it. The per-channel group is byte-equal to that channel's own
// `/features/:slug/revenue?offerId=` headline and costEconomics: same campaign scope, same brand
// pricing, same engine. So a channel row and the offer total above it are one statement at two grains,
// and a caller never has to reconcile two numbers.
//
// No `?lens=` and no `?groupBy=`: a lens narrows to a subset of LEADS (its spend leg would still be
// the whole offer's), and the only grouping this grain has is the channel breakdown, which ships
// unconditionally. Both stay available per channel on the existing reads.
router.get("/offers/:offerId/revenue", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, pricing, headers, channels, campaignIds, featureSlugs } = resolved;

    // `?funnel=` names the SALES FUNNEL the spend block's cost-per-outcome columns are priced on, with
    // the same meaning and the same fail-loud parse as the per-feature read.
    let requestedFunnel: SalesFunnelKey | undefined;
    const funnelParam = req.query.funnel as string | undefined;
    if (funnelParam) {
      const matched = matchSalesFunnelKey(funnelParam);
      if (!matched) return res.status(400).json({ error: `funnel must be one of: ${SALES_FUNNEL_KEYS.join(", ")}` });
      requestedFunnel = matched;
    }

    const funnel = resolveOfferFunnel(offerId, channels);

    // Economics are BRAND-scoped (an offer states no rates of its own — brand-service owns those), so
    // they are read ONCE here and shared by the offer body and every channel group: N channels cost
    // one brand-service call, and the fingerprint rides the cache key so an economics write lands on a
    // different cell instead of replaying the pre-write answer.
    const [declaredFunnels, brandEconomics] = funnel
      ? await Promise.all([
          // THIS offer's declared chains — its own lifetime revenue and its own rates. The offer grain
          // is the one read that genuinely knows which proposition it is pricing, so it is the one that
          // names it; every brand-scoped read keeps resolving the sole offer as before.
          fetchDeclaredFunnelsSoft(brandId, headers.orgId, offerId),
          fetchEffectiveEconomics(brandId, headers),
        ])
      : [[], null];
    const brandPriced: FunnelPricedEconomics | undefined = brandEconomics
      ? priceOnDeclaredFunnel(declaredFunnels, brandEconomics, requestedFunnel)
      : undefined;
    const econ = brandPriced ? economicsFingerprint(brandPriced.economics) : undefined;
    const decl = funnel ? declaredFunnels.map((f) => f.funnelKey).sort().join("+") || "none" : undefined;

    const payload = await servedCached({
      view: "offer-revenue",
      // Keyed on the offer, never on a feature — and on the CHANNEL SET too, because a newly funded
      // channel changes every figure while none of the other key parts moves.
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        channels: featureSlugs.join("+"),
        funnel: requestedFunnel,
        decl,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      compute: async () => {
        // ONE engine pass over the offer's whole evidence set — see the additive/non-additive note in
        // this file's header for why this is a single pass rather than N results combined.
        const body = await computeFeatureRevenue(
          featureSlugs,
          brandId,
          campaignIds,
          funnel,
          headers,
          undefined,
          brandPriced,
          true,
          pricing,
          requestedFunnel,
          offerId,
        );
        // The breakdown. LEAN on purpose (headline + costEconomics, the shape the per-offer and
        // per-workflow groups already use): a full body per channel would repeat the whole lead
        // population once per channel for figures the offer body already carries.
        const groups = await mapWithConcurrency(channels, 4, async (channel) => {
          const channelBody = await computeFeatureRevenue(
            channel.featureSlug,
            brandId,
            channel.campaignIds,
            getFunnel(channel.featureSlug),
            headers,
            undefined,
            brandPriced,
            false,
            pricing,
            requestedFunnel,
            offerId,
          );
          return {
            featureSlug: channel.featureSlug,
            campaignIds: channel.campaignIds,
            headline: channelBody.headline,
            costEconomics: channelBody.costEconomics,
          };
        });
        return { offerId, brandId, costBasis: "charged" as const, channels: groups, ...body };
      },
    });

    res.json(payload);
  } catch (error) {
    if (error instanceof OfferHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
    }
    if (error instanceof OfferChannelsPriceDifferentlyError) {
      return res.status(409).json({ error: error.message, reason: "offer_channels_price_differently", offerId: error.offerId });
    }
    console.error("[features-service] Offer revenue error:", error);
    res.status(502).json({ error: "Failed to compute offer revenue" });
  }
});

// ── GET /offers/:offerId/audience-stats ──────────────────────────────────────
//
// The offer's per-audience economics, across every channel. Audiences are BRAND entities (human-service
// owns them, and several offers may address the same one), so the audience LIST is unchanged; what
// narrows is the money and the engagement behind each row.
//
// Both of those are per-audience send-tag figures, and a send carries exactly one campaign and one
// channel — so they add across channels with nothing counted twice, and again the producer does the
// adding (runs-service comma-splits `featureSlugs`; email-gateway is read once per channel and the
// per-audience buckets merged). The RATIOS on each row are then recomputed from those combined
// numerators, never averaged.
router.get("/offers/:offerId/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, pricing, headers, channels, campaignIds, featureSlugs } = resolved;

    let econ: string | undefined;
    try {
      econ = economicsFingerprint(await fetchEffectiveEconomics(brandId, headers));
    } catch (err) {
      // Feeds the KEY, not the response — degrading to "no fingerprint" keeps the compute (which reads
      // economics fail-loud) the one that decides this request's status.
      console.warn(`[features-service] offer audience-stats economics fingerprint unavailable: ${(err as Error).message}`);
    }

    const result = await servedCached<ComputeResult>({
      view: "offer-audience-stats",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        channels: featureSlugs.join("+"),
        goal: req.query.goal,
        funnel: req.query.funnel,
        statuses: req.query.statuses,
        limit: req.query.limit,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      compute: () => computeAudienceStats(req, pricing, campaignIds, channels),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ offerId, channels: describeChannels(channels), ...result.envelope });
  } catch (error) {
    if (error instanceof OfferHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
    }
    console.error("[features-service] Offer audience stats error:", error);
    res.status(502).json({ error: "Failed to compute offer audience stats" });
  }
});

// ── GET /offers/:offerId/pipeline-activity ───────────────────────────────────
//
// The offer's per-day activity, across every channel. Every series here is an EVENT count tagged to one
// campaign, so the channels add exactly — and they are added by reading each channel under its OWN slug
// and merging the day buckets, rather than by trusting a plural filter this producer has not been
// verified to split.
//
// The EXPECTED series, the daily budget and the conversion actuals are null under an offer scope for
// the reasons the per-feature offer read already states: a budget is funded per brand with no per-offer
// ceiling to divide, and the conversion tracker is brand-keyed with no campaign on it. Drawing either
// brand-wide beside offer-only bars would put two grains on one chart.
router.get("/offers/:offerId/pipeline-activity", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveRequest(req as never);
    if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
    const { offerId, brandId, pricing, headers, channels } = resolved;

    const payload = await computeOfferPipelineActivity(req as never, {
      offerId,
      brandId,
      pricing,
      channels,
      headers: { orgId: headers.orgId, userId: headers.userId ?? "", runId: headers.runId ?? "" },
    });
    if (!payload.ok) return res.status(payload.status).json(payload.body);
    res.json({ offerId, channels: describeChannels(channels), ...payload.body });
  } catch (error) {
    if (error instanceof OfferHasNoChannelsError) {
      return res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
    }
    console.error("[features-service] Offer pipeline activity error:", error);
    res.status(502).json({ error: "Failed to compute offer pipeline activity" });
  }
});

export default router;
