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
  buildOfferChannelMap,
  offerCampaignIds,
  offerFeatureSlugs,
  OfferHasNoChannelsError,
  type OfferChannel,
} from "../lib/offer-channels.js";
import { buildOfferChains, type OfferChain } from "../lib/offer-chains.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { fetchBrandStepCostsSoft } from "../lib/step-costs-client.js";
import {
  partitionCustomerCosts,
  coverageOf,
  summariseCoverage,
  type ChainCostCoverage,
  type CustomerDeclaredCost,
} from "../lib/chain-customer-costs.js";
import { buildCombinedCostEconomics } from "../lib/cost-economics.js";

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

/**
 * Why a chain's money could not be turned into a return. See the `/offers/:offerId/chains` header for
 * the order they are checked in and what each one leaves populated.
 */
export type ChainUnpricedReason = "no_channel_funnel" | "no_economics_declared" | "chain_not_declared";

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


// ── GET /offers/:offerId/chains ──────────────────────────────────────────────
//
// WHAT EACH OF THIS OFFER'S SALES CHAINS COST AND RETURNED — one lean row per chain, in ONE request.
//
// A customer reads the return of their brand, and of each of their offers. The grain under that is the
// SALES CHAIN, and it is the one that is about to matter most: the product is moving to ONE CAMPAIGN
// PER STEP, so a campaign will buy a single link and have a cost per step but NO return of its own —
// the lifetime revenue sits at the END of the chain, and hanging it on whichever link happened to be
// last would wildly overstate that link. The chain is the smallest scope that spans a whole path to a
// paying client, so it is the smallest scope whose money divides into a return.
//
// It is correct under BOTH shapes with no switch: the row is scoped to the chain's CAMPAIGN SET, so a
// chain served by one campaign (every chain in production today) and a chain served by one campaign
// per step read through the identical code — the set simply grows.
//
// ── THE ROW IS THE SAME COMPUTATION THE OFFER READ MAKES, NARROWED ─────────────────────────────
//
// Same engine, same brand pricing, same committed basis, `includeSpend: false` — the LEAN shape the
// offer, channel, campaign and workflow groups already use. So a chain row and the offer total above
// it are one statement at two grains rather than two computations to reconcile.
//
// ── WHAT ADDS AND WHAT DOES NOT ────────────────────────────────────────────────────────────────
//
// A campaign states exactly one chain, so MONEY adds: Σ chains + Σ unattributed IS the offer's own
// spend. PEOPLE do not — a lead worked through two chains is ONE lead to the offer and belongs to both
// rows — so the rows do not sum on the pipeline half and the offer read stays the number to trust for
// "what did this offer do". Same counting-people property every grain here already carries.
//
// ── A CHAIN WE CANNOT PRICE SAYS SO, AND NAMES THE MISSING INGREDIENT ──────────────────────────
//
// `priced: false` + `unpricedReason`, checked in the order below so the plain thing is said first:
//
//   no_channel_funnel     — no channel carrying this chain measures anything (no funnel wired). The
//                           leads are never read, so `outcomes` is null too: nothing counted them.
//   no_economics_declared — the brand states no economics, or its declaration could not be read. This
//                           chain therefore has no rates and no lifetime revenue of its own.
//   chain_not_declared    — the declaration IS readable and does not contain this chain.
//
// In all three the SPEND is real and reported (the customer paid it) and the pipeline, the return and
// the cost of acquisition are null. Never 0, and never the brand-wide fallback the un-narrowed reads
// legitimately take: pricing chain A on a brand-wide record — whose every rate is server-defaulted —
// is exactly the fiction the retired goal produced, one grain finer.
//
// ── TWO OWNERS OF MONEY, TOLD APART ────────────────────────────────────────────────────────────
//
// The platform automates the first link of a chain and CHARGES for it; the customer performs the rest —
// they run the meeting, they close the deal — and lead-service now records what those legs cost THEM
// (`GET /internal/brands/:brandId/step-costs`). A cost of acquisition that counts only the billed link
// is too small for every chain ending in a human leg, and the return dividing by it is too good.
//
// So the row states both, apart:
//
//   costEconomics          — what the customer was CHARGED. A billing fact, unchanged, unwidened.
//   customerCost           — what THEY state their own legs cost. Never charged, in no ledger of ours,
//                            and it never reaches billing.
//   combinedCostEconomics  — the two together, and the return that divides by that sum.
//
// A statement is made on a lead row, which belongs to a CAMPAIGN, and a campaign states exactly one
// chain — so the campaign set that scopes a row's charged spend scopes its declared spend too, with
// nothing inferred. A statement naming no campaign, or a campaign in no chain of this offer, is
// reported apart (`customerCost.unattributed`) rather than dropped or parked on a default.
//
// A STATED ZERO IS AN ANSWER; AN UNSTATED LEG IS NOT. A leg nobody was ever asked about contributes
// nothing to the sum and raises `unstatedCount`, and the chain then says `platform_and_partial_customer_spend`
// — a chain we cannot fully cost says so instead of guessing at the rest. With nothing declared at all
// the row reads exactly as it did before this and the marker still says `platform_spend_only`, which
// is why the basis on the wire is always TRUE rather than always the same.
//
// The read is fail-SOFT: an unreadable statement set degrades the customer half (null, loud log) rather
// than 502-ing a row whose charged money, volume and platform-priced return are all correct.
router.get("/offers/:offerId/chains", apiKeyAuth, async (req, res) => {
  try {
    const authed = req as AuthenticatedRequest & { params: { offerId: string } };
    const offerId = authed.params.offerId;
    const brandId = (req.query.brandId as string | undefined) ?? "";
    if (!brandId) return res.status(400).json({ error: "brandId query parameter is required" });

    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return res.status(400).json({ error: "pricing must be one of: gross, net" });

    const headers: DownstreamHeaders = {
      orgId: authed.orgId,
      userId: authed.userId,
      runId: authed.runId,
      // A chain is sold through however many channels carry it, so naming one would attribute the read
      // to a channel the caller never asked about.
      featureSlug: undefined,
    };

    // ONE campaign read answers both questions: does any campaign of this brand sell this offer (the
    // 404), and how do those campaigns partition by chain. Reading it twice would be the same rows.
    const rows = await fetchBrandCampaignRows(brandId, undefined, {
      orgId: authed.orgId,
      userId: authed.userId,
      runId: authed.runId,
    });
    if (buildOfferChannelMap(rows).channelsOf(offerId).length === 0) {
      throw new OfferHasNoChannelsError(offerId, brandId);
    }
    const { chains, unattributedCampaignIds } = buildOfferChains(rows, offerId);

    // Economics and the declaration are BRAND-scoped for THIS offer, so they are read ONCE and shared
    // by every row: N chains cost one pair of calls, and both ride the cache key so a write lands on a
    // new cell instead of replaying the pre-write answer. Skipped entirely when no chain has a channel
    // that measures anything — there is then nothing to price.
    const anyFunnel = chains.some((chain) => distinctChannelFunnels(chain.channels).length > 0);
    // The customer's own statements are read whether or not a chain can be PRICED: what they spent on
    // a leg is a fact about their money, not about our ability to turn it into a return. One
    // brand-scoped read serves every row, exactly as the economics pair beside it does.
    const [declaredFunnels, brandEconomics, stepCosts] = anyFunnel
      ? await Promise.all([
          fetchDeclaredFunnelsSoft(brandId, headers.orgId, offerId),
          fetchEffectiveEconomics(brandId, headers),
          fetchBrandStepCostsSoft(brandId),
        ])
      : [[], null, await fetchBrandStepCostsSoft(brandId)];
    const customerCosts = stepCosts
      ? partitionCustomerCosts(
          stepCosts.costs,
          chains.map((chain) => ({ key: chain.funnelKey, campaignIds: chain.campaignIds })),
        )
      : null;
    const declaredKeys = new Set(declaredFunnels.map((f) => f.funnelKey));
    const decl = anyFunnel ? [...declaredKeys].sort().join("+") || "none" : undefined;
    const econ = brandEconomics ? economicsFingerprint(brandEconomics) : undefined;

    const payload = await servedCached({
      view: "offer-chains",
      // The whole (chain × channel) partition rides the key, not just the chain list: a newly funded
      // channel on one chain changes that row's every figure while no other key part moves.
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        chains: chains
          .map((chain) => `${chain.funnelKey}>${chain.channels.map((c) => c.featureSlug).join("+")}`)
          .join(","),
        unattributed: unattributedCampaignIds.join("+"),
        // The customer's declared money is part of every combined figure below, so a new statement has
        // to land on a NEW cell rather than replay the answer from before it was made — the same
        // reasoning as the economics fingerprint beside it.
        cust: stepCosts
          ? `${stepCosts.costs.length}:${stepCosts.costs.reduce((n, c) => n + (c.costCents ?? 0), 0)}`
          : "unavailable",
        decl,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      compute: async () => {
        const groups = await mapWithConcurrency(chains, 4, async (chain: OfferChain) => {
          // Each chain resolves the measurement funnel of ITS OWN channels — a chain whose channels
          // price two ways says so (409) rather than having one silently picked for it.
          const funnel = resolveOfferFunnel(offerId, chain.channels);
          const unpricedReason: ChainUnpricedReason | null = !funnel
            ? "no_channel_funnel"
            : declaredFunnels.length === 0 || !brandEconomics?.economics
              ? "no_economics_declared"
              : !declaredKeys.has(chain.funnelKey)
                ? "chain_not_declared"
                : null;

          // PRICED: the chain's OWN declared terms merged over the brand-wide record — its own rates
          // and its own lifetime revenue, and its own legs are the only ones carrying expected value.
          //
          // UNPRICED but measurable: the same read with the economics deliberately nulled, which is the
          // engine's cold-start path — real spend, real volume, null pipeline. The leads are still
          // read, because "we could not price this" and "this reached nobody" are different statements.
          const economicsOverride: FunnelPricedEconomics | undefined = !brandEconomics
            ? undefined
            : unpricedReason === null
              ? priceOnDeclaredFunnel(declaredFunnels, brandEconomics, chain.funnelKey)
              : { economics: { ...brandEconomics, economics: null }, pricedFunnelKeys: [chain.funnelKey] };

          const body = await computeFeatureRevenue(
            chain.channels.map((c) => c.featureSlug),
            brandId,
            chain.campaignIds,
            unpricedReason === "no_channel_funnel" ? null : funnel,
            headers,
            undefined,
            economicsOverride,
            false,
            pricing,
            chain.funnelKey,
            offerId,
          );
          // The customer's own legs, scoped by the SAME campaign set the charged money is scoped by.
          // `null` only when the statements could not be read at all — never when nobody stated one,
          // which is a real answer and reads as zeros.
          const customerCost: CustomerDeclaredCost | null = customerCosts?.byChain[chain.funnelKey] ?? null;
          const coverage: ChainCostCoverage = coverageOf(customerCost);
          return {
            funnelKey: chain.funnelKey,
            name: chain.name,
            steps: chain.steps,
            campaignIds: chain.campaignIds,
            channels: chain.channels.map((c) => ({ featureSlug: c.featureSlug, campaignIds: c.campaignIds })),
            priced: unpricedReason === null,
            unpricedReason,
            headline: body.headline,
            costEconomics: body.costEconomics,
            customerCost: customerCost
              ? {
                  declaredCostUsd: customerCost.costCents / 100,
                  statedCount: customerCost.statedCount,
                  unstatedCount: customerCost.unstatedCount,
                }
              : null,
            costCoverage: coverage,
            // The chain's OWN lifetime revenue — the same one its pipeline was priced on — so the
            // combined return is the charged one moved by exactly the customer's money and nothing else.
            combinedCostEconomics: buildCombinedCostEconomics({
              charged: body.costEconomics,
              customerDeclaredCostCents: customerCost?.costCents ?? 0,
              totalPipelineUsd: body.headline.totalPipelineUsd,
              lifetimeRevenueUsd: economicsOverride?.economics.economics?.lifetimeRevenueUsd ?? null,
            }),
            outcomes: body.outcomes,
          };
        });
        return {
          offerId,
          brandId,
          costBasis: "charged" as const,
          // The WEAKEST coverage among the rows, because the marker is an admission: a payload holding
          // one fully-costed chain and one that could not be costed at all is not a fully-costed payload.
          costCoverage: summariseCoverage(groups.map((g) => g.costCoverage)),
          // `null` = the statements could not be READ; zeros = nobody has stated one. Two different
          // things a consumer acts on differently, so they are never collapsed.
          customerCost: customerCosts
            ? {
                declaredCostUsd:
                  (Object.values(customerCosts.byChain).reduce((n, c) => n + c.costCents, 0) +
                    customerCosts.unattributed.costCents) /
                  100,
                statedCount:
                  Object.values(customerCosts.byChain).reduce((n, c) => n + c.statedCount, 0) +
                  customerCosts.unattributed.statedCount,
                unstatedCount:
                  Object.values(customerCosts.byChain).reduce((n, c) => n + c.unstatedCount, 0) +
                  customerCosts.unattributed.unstatedCount,
                // Statements naming no campaign, or a campaign in no chain of this offer. In NO row,
                // stated here so a reader sees the difference rather than wondering where they went.
                unattributed: {
                  declaredCostUsd: customerCosts.unattributed.costCents / 100,
                  statedCount: customerCosts.unattributed.statedCount,
                  unstatedCount: customerCosts.unattributed.unstatedCount,
                },
              }
            : null,
          chains: groups,
          unattributedCampaignIds,
        };
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
    console.error("[features-service] Offer chains error:", error);
    res.status(502).json({ error: "Failed to compute offer chain economics" });
  }
});

export default router;
