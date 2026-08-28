/**
 * ONE SALES FUNNEL OF ONE OFFER, ANSWERED IN MONEY AT ITS OWN GRAIN.
 *
 * A customer opens a sales funnel and asks the same question they ask of an offer or of their brand:
 * is this working, and what is it returning. `GET /offers/:offerId/funnels` already answers that at
 * the grain of a TABLE — a lean row per funnel, four figures each — which is the right shape for a
 * list and the wrong shape for a page. What the offer grain carries beyond it is exactly what a
 * funnel's own screen has to draw: the spend broken down the way the cost card reads it, the return
 * over the customer's whole life with the brand, and the dated series behind the activity chart.
 *
 * So these three reads are the offer's three, narrowed to ONE funnel:
 *
 *   GET /offers/:offerId/funnels/:funnelKey/revenue            — the funnel's money, in full
 *   GET /offers/:offerId/funnels/:funnelKey/audience-stats     — the funnel's per-audience economics
 *   GET /offers/:offerId/funnels/:funnelKey/pipeline-activity  — the funnel's per-day activity
 *
 * ── THE NARROWING IS A FUNNEL WITHIN AN OFFER, AND THE SCOPE IS A CAMPAIGN SET ──────────────────
 *
 * A campaign states exactly one offer and exactly one sales funnel, and campaign-service owns both
 * (its `uniq_campaigns_org_brand_funnel_channel` key). So the scope of every figure here is the SAME
 * campaign set `/offers/:offerId/funnels` builds its row from — `buildOfferFunnels`, one partition,
 * never re-derived and never inferred from a goal (two funnels answer to `meetingBooked`).
 *
 * That is what makes this correct under BOTH product shapes with no switch. A funnel served by ONE
 * campaign — every funnel in production today — issues the byte-same downstream reads that campaign's
 * own `?campaignId=` read issues. A funnel served by one campaign per STEP is the same read over a
 * larger set: the money adds, the leads dedupe, and the return is the funnel's rather than whichever
 * link happened to be last. Partial coverage is therefore normal here BY CONSTRUCTION — a funnel with
 * a campaign on two of its four legs answers with the two it has, and says nothing about the rest.
 *
 * ── WHAT IS NOT DONE HERE, AND WHY ──────────────────────────────────────────────────────────────
 *
 * NOT the offer's numbers under a funnel's name. Every read below is scoped to the funnel's own
 * campaigns before anything is computed; nothing renders a wider scope's shape as a narrower one's.
 * NOT a browser-side sum of the funnel's campaigns either: a ratio of sums is neither the sum nor the
 * average of the ratios, and people do not add at all (one lead worked through two of a funnel's steps
 * is ONE lead). Both combinations happen HERE, in one engine pass, exactly as they do one grain up.
 *
 * ── EVERY RULE OF THE WIDER GRAINS SURVIVES ─────────────────────────────────────────────────────
 *
 * Same COMMITTED accounting basis and same `costBasis: "charged"`. The funnel is priced on its OWN
 * declared terms through the shared `priceFunnelRow`, so this page and the offer's table can never
 * print two prices for one funnel. A funnel that cannot be priced says which ingredient is missing
 * and reports its real spend beside a null return — never 0, never the brand-wide record. The
 * customer's own declared money stays apart from what we charged. Nothing is fabricated: a figure we
 * cannot measure is null and says so.
 */
import { Router } from "express";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth.js";
import {
  computeFeatureRevenue,
  fetchDeclaredFunnelsSoft,
  type DownstreamHeaders,
} from "./revenue.js";
import {
  resolveOfferFunnel,
  priceFunnelRow,
  OfferChannelsPriceDifferentlyError,
} from "./offer-economics.js";
import { computeAudienceStats, type ComputeResult } from "../lib/audience-stats-compute.js";
import { computeOfferPipelineActivity } from "./pipeline-activity.js";
import { fetchEffectiveEconomics, economicsFingerprint } from "../lib/sales-economics-client.js";
import { servedCached, buildScopeKey } from "../lib/view-cache.js";
import { parsePricing, type Pricing } from "../lib/pricing.js";
import { matchSalesFunnelKey, SALES_FUNNEL_KEYS, type SalesFunnelKey } from "../lib/sales-funnels.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { buildOfferChannelMap, OfferHasNoChannelsError } from "../lib/offer-channels.js";
import { buildOfferFunnels, type OfferFunnel } from "../lib/offer-funnels.js";
import { fetchBrandCampaignRows } from "../lib/campaign-identity-client.js";
import { fetchBrandStepCostsSoft } from "../lib/step-costs-client.js";
import {
  partitionCustomerCosts,
  coverageOf,
  type CustomerDeclaredCost,
} from "../lib/funnel-customer-costs.js";
import { buildCombinedCostEconomics } from "../lib/cost-economics.js";

const router = Router();

/**
 * The offer sells through channels, but none of its campaigns sells through the funnel asked about.
 *
 * A NAMED 404, never an empty body and never the offer's own figures: "this funnel has produced
 * nothing" and "nobody sells this offer through this funnel" are different statements, and only the
 * second one is true here. The funnels the offer DOES sell through ride the body, so a consumer can
 * send the reader somewhere real.
 */
export class OfferFunnelNotSoldError extends Error {
  constructor(
    readonly offerId: string,
    readonly funnelKey: SalesFunnelKey,
    readonly soldFunnelKeys: SalesFunnelKey[],
  ) {
    super(`no campaign of offer ${offerId} sells through the sales funnel ${funnelKey}`);
    this.name = "OfferFunnelNotSoldError";
  }
}

interface FunnelScope {
  offerId: string;
  brandId: string;
  pricing: Pricing;
  headers: DownstreamHeaders;
  /** The funnel's own campaign set and channels — the SAME partition the offer's table is built from. */
  row: OfferFunnel;
  /** Every funnel the offer sells through, so a response can state what it is one of. */
  soldFunnelKeys: SalesFunnelKey[];
}

/**
 * Shared parsing + scoping for all three reads.
 *
 * ONE campaign read answers every question this grain has: does the offer exist at all (the
 * `offer_has_no_channels` 404), which funnels it sells through, and which campaigns carry the one
 * asked about. Reading it per question would be the same rows fetched three times.
 */
async function resolveFunnelScope(
  req: AuthenticatedRequest & { params: { offerId: string; funnelKey: string }; query: Record<string, unknown> },
): Promise<{ ok: true; scope: FunnelScope } | { ok: false; status: number; body: Record<string, unknown> }> {
  const offerId = req.params.offerId;
  const brandId = (req.query.brandId as string | undefined) ?? "";
  if (!brandId) return { ok: false, status: 400, body: { error: "brandId query parameter is required" } };

  const pricing = parsePricing(req.query.pricing);
  if (pricing === null) return { ok: false, status: 400, body: { error: "pricing must be one of: gross, net" } };

  // A word naming no funnel is a 400, never a silent pick — the same fail-loud parse every funnel-keyed
  // read makes, and it accepts every pre-retirement spelling forever.
  const funnelKey = matchSalesFunnelKey(req.params.funnelKey);
  if (!funnelKey) {
    return { ok: false, status: 400, body: { error: `funnelKey must be one of: ${SALES_FUNNEL_KEYS.join(", ")}` } };
  }

  const headers: DownstreamHeaders = {
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
    // A funnel is carried by however many channels perform its legs, so naming one would attribute the
    // read to a channel the caller never asked about.
    featureSlug: undefined,
  };

  const rows = await fetchBrandCampaignRows(brandId, undefined, {
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
  });
  if (buildOfferChannelMap(rows).channelsOf(offerId).length === 0) {
    throw new OfferHasNoChannelsError(offerId, brandId);
  }
  const { funnels } = buildOfferFunnels(rows, offerId);
  const row = funnels.find((f) => f.funnelKey === funnelKey);
  if (!row) throw new OfferFunnelNotSoldError(offerId, funnelKey, funnels.map((f) => f.funnelKey));

  return { ok: true, scope: { offerId, brandId, pricing, headers, row, soldFunnelKeys: funnels.map((f) => f.funnelKey) } };
}

/** The `channels` key every response carries — the legs of this funnel that are actually funded. */
function describeChannels(row: OfferFunnel) {
  return row.channels.map((channel) => ({ featureSlug: channel.featureSlug, campaignIds: channel.campaignIds }));
}

/** Maps this grain's two named refusals onto their responses. Shared by all three reads. */
function handleScopeError(error: unknown, res: import("express").Response): boolean {
  if (error instanceof OfferHasNoChannelsError) {
    res.status(404).json({ error: error.message, reason: "offer_has_no_channels", offerId: error.offerId });
    return true;
  }
  if (error instanceof OfferFunnelNotSoldError) {
    res.status(404).json({
      error: error.message,
      reason: "funnel_not_sold",
      offerId: error.offerId,
      funnelKey: error.funnelKey,
      soldFunnelKeys: error.soldFunnelKeys,
    });
    return true;
  }
  if (error instanceof OfferChannelsPriceDifferentlyError) {
    res
      .status(409)
      .json({ error: error.message, reason: "offer_channels_price_differently", offerId: error.offerId });
    return true;
  }
  return false;
}

// ── GET /offers/:offerId/funnels/:funnelKey/revenue ──────────────────────────
//
// THE FUNNEL'S OWN MONEY, IN FULL — the offer read narrowed to one funnel, and the reason this route
// exists rather than the table row already serving.
//
// The row on `/offers/:offerId/funnels` is LEAN on purpose: a table polls it, so it carries the
// headline and the cost block and nothing else. A funnel's PAGE draws what an offer's page draws, and
// three of those things are simply not on a lean row:
//
//   spend       — the breakdown per cost source the cost card reads, plus today's spend. Without it a
//                 customer sees a total with none of the detail their offer page gives them.
//   roiHistory  — the return on spend over the brand's whole life, both legs cumulative and both
//                 MEASURED, terminating exactly on the headline ROI above it.
//   the series  — recipientsContacted / opened / clicked / replies, plus `leads[]` and the events
//                 ledger, all bucketed by each lead's own first-occurrence date.
//
// Every one of them is `includeSpend: true` on the SAME compute the row makes, over the SAME campaign
// scope — so the page and the row are one statement at two levels of detail, not two computations to
// reconcile. That is also why the funnel page draws its own chart at last: the series here are the
// funnel's campaigns and nobody else's, so nothing borrows the offer's shape under the funnel's name.
//
// The customer's own declared money rides it exactly as it rides the row (`customerCost`,
// `costCoverage`, `combinedCostEconomics`), for the same reason: a funnel ending in a human leg reads
// cheaper than it truly is when only the billed link is counted.
router.get("/offers/:offerId/funnels/:funnelKey/revenue", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveFunnelScope(req as never);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    const { offerId, brandId, pricing, headers, row } = resolved.scope;

    // The MEASUREMENT funnel of this funnel's OWN channels — a funnel whose channels price two ways
    // says so (409) rather than having one silently picked for it.
    const funnel = resolveOfferFunnel(offerId, row.channels);

    // Economics, the declaration and the customer's statements are all BRAND-scoped for THIS offer, so
    // each is read ONCE and shared by the funnel body and its channel rows. The statements are read
    // whether or not the funnel can be PRICED: what the customer spent on a leg is a fact about their
    // money, not about our ability to turn it into a return.
    const [declaredFunnels, brandEconomics, stepCosts] = funnel
      ? await Promise.all([
          fetchDeclaredFunnelsSoft(brandId, headers.orgId, offerId),
          fetchEffectiveEconomics(brandId, headers),
          fetchBrandStepCostsSoft(brandId),
        ])
      : [[], null, await fetchBrandStepCostsSoft(brandId)];

    const { unpricedReason, economicsOverride } = priceFunnelRow({
      funnelKey: row.funnelKey,
      hasChannelFunnel: funnel !== null,
      declaredFunnels,
      brandEconomics,
    });

    // Only THIS funnel's campaign set is asked for. The leftovers of the partition are other funnels'
    // statements, which are not this row's business — the offer read is where they are accounted for.
    const customerCost: CustomerDeclaredCost | null = stepCosts
      ? partitionCustomerCosts(stepCosts.costs, [{ key: row.funnelKey, campaignIds: row.campaignIds }]).byFunnel[
          row.funnelKey
        ]
      : null;

    const econ = economicsOverride ? economicsFingerprint(economicsOverride.economics) : undefined;
    const decl = funnel ? declaredFunnels.map((f) => f.funnelKey).sort().join("+") || "none" : undefined;

    const payload = await servedCached({
      view: "offer-funnel-revenue",
      // The funnel's whole (funnel × channel) scope rides the key: a newly funded leg changes every
      // figure below while no other key part moves.
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        funnel: row.funnelKey,
        channels: row.channels.map((c) => `${c.featureSlug}>${c.campaignIds.join("+")}`).join(","),
        // A new statement has to land on a NEW cell rather than replay the answer from before it was
        // made — the same reasoning as the economics fingerprint beside it.
        cust: stepCosts
          ? `${stepCosts.costs.length}:${stepCosts.costs.reduce((n, c) => n + (c.costCents ?? 0), 0)}`
          : "unavailable",
        decl,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      compute: async () => {
        // ONE engine pass over the funnel's whole evidence set. `includeSpend: true` is what makes this
        // a PAGE rather than a row: the spend breakdown, the return-on-spend curve and the day series.
        const body = await computeFeatureRevenue(
          row.channels.map((c) => c.featureSlug),
          brandId,
          row.campaignIds,
          unpricedReason === "no_channel_funnel" ? null : funnel,
          headers,
          undefined,
          economicsOverride,
          true,
          pricing,
          row.funnelKey,
          offerId,
          // The SAME statements the funnel-wide figure above is built from, read ONCE for this
          // request: the per-rung answer is a partition of those rows, so the page cannot state one
          // basis for the funnel and another for its steps, and nothing is fetched twice.
          stepCosts,
        );
        // The per-channel breakdown WITHIN the funnel — which of its legs is funded, and what each one
        // cost and returned. LEAN, like every other breakdown here: the bodies would otherwise repeat
        // the whole lead population once per leg for figures the funnel body already carries.
        const channels = await mapWithConcurrency(row.channels, 4, async (channel) => {
          const channelBody = await computeFeatureRevenue(
            channel.featureSlug,
            brandId,
            channel.campaignIds,
            unpricedReason === "no_channel_funnel" ? null : funnel,
            headers,
            undefined,
            economicsOverride,
            false,
            pricing,
            row.funnelKey,
            offerId,
          );
          return {
            featureSlug: channel.featureSlug,
            campaignIds: channel.campaignIds,
            headline: channelBody.headline,
            costEconomics: channelBody.costEconomics,
            outcomes: channelBody.outcomes,
          };
        });
        return {
          offerId,
          brandId,
          funnelKey: row.funnelKey,
          name: row.name,
          steps: row.steps,
          campaignIds: row.campaignIds,
          costBasis: "charged" as const,
          priced: unpricedReason === null,
          unpricedReason,
          channels,
          costCoverage: coverageOf(customerCost),
          customerCost: customerCost
            ? {
                declaredCostUsd: customerCost.costCents / 100,
                statedCount: customerCost.statedCount,
                unstatedCount: customerCost.unstatedCount,
              }
            : null,
          // The funnel's OWN lifetime revenue — the same one its pipeline was priced on — so the
          // combined return is the charged one moved by exactly the customer's money and nothing else.
          combinedCostEconomics: buildCombinedCostEconomics({
            charged: body.costEconomics,
            customerDeclaredCostCents: customerCost?.costCents ?? 0,
            totalPipelineUsd: body.headline.totalPipelineUsd,
            lifetimeRevenueUsd: economicsOverride?.economics.economics?.lifetimeRevenueUsd ?? null,
          }),
          ...body,
        };
      },
    });

    res.json(payload);
  } catch (error) {
    if (handleScopeError(error, res)) return;
    console.error("[features-service] Offer funnel revenue error:", error);
    res.status(502).json({ error: "Failed to compute offer funnel revenue" });
  }
});

// ── GET /offers/:offerId/funnels/:funnelKey/audience-stats ───────────────────
//
// The funnel's per-audience economics. Audiences are BRAND entities (human-service owns them, and
// several funnels may address the same one), so the audience LIST is unchanged; what narrows is the
// money and the engagement behind each row, to this funnel's campaigns.
//
// Both are per-audience SEND-TAG figures and a send carries exactly one campaign, so they add across
// the funnel's legs with nothing counted twice — and each row's ratios are then recomputed from those
// combined numerators, never averaged.
router.get("/offers/:offerId/funnels/:funnelKey/audience-stats", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveFunnelScope(req as never);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    const { offerId, brandId, pricing, headers, row } = resolved.scope;

    let econ: string | undefined;
    try {
      econ = economicsFingerprint(await fetchEffectiveEconomics(brandId, headers));
    } catch (err) {
      // Feeds the KEY, not the response — degrading to "no fingerprint" keeps the compute (which reads
      // economics fail-loud) the one that decides this request's status.
      console.warn(
        `[features-service] offer funnel audience-stats economics fingerprint unavailable: ${(err as Error).message}`,
      );
    }

    const result = await servedCached<ComputeResult>({
      view: "offer-funnel-audience-stats",
      scopeKey: buildScopeKey(offerId, {
        orgId: headers.orgId,
        brandId,
        funnel: row.funnelKey,
        channels: row.channels.map((c) => `${c.featureSlug}>${c.campaignIds.join("+")}`).join(","),
        goal: req.query.goal,
        funnelParam: req.query.funnel,
        statuses: req.query.statuses,
        limit: req.query.limit,
        pricing,
        econ,
      }),
      orgId: headers.orgId,
      compute: () => computeAudienceStats(req, pricing, row.campaignIds, row.channels),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ offerId, funnelKey: row.funnelKey, channels: describeChannels(row), ...result.envelope });
  } catch (error) {
    if (handleScopeError(error, res)) return;
    console.error("[features-service] Offer funnel audience stats error:", error);
    res.status(502).json({ error: "Failed to compute offer funnel audience stats" });
  }
});

// ── GET /offers/:offerId/funnels/:funnelKey/pipeline-activity ────────────────
//
// THE FUNNEL'S OWN DAY CHART — the reason the funnel page draws no chart today.
//
// The consumer refused to render the offer's series under the funnel's name, which is right: a wider
// scope's shape stated as a narrower one's is a lie. This is the same series read under the funnel's
// OWN campaigns, so there is nothing to borrow. Every bar is an EVENT count tagged to one campaign, so
// the funnel's legs add exactly, and they are added by reading each leg under its own channel and
// merging the day buckets.
//
// The EXPECTED series, `summary.dailyBudgetUsd` and the observed conversion actuals stay NULL for the
// reasons the offer grain already states one level up: a budget is funded per brand with no per-funnel
// ceiling to divide, and the conversion tracker is brand-keyed with no campaign on it. Null is "we
// could not measure this at this grain", never a share and never a zero.
router.get("/offers/:offerId/funnels/:funnelKey/pipeline-activity", apiKeyAuth, async (req, res) => {
  try {
    const resolved = await resolveFunnelScope(req as never);
    if (!resolved.ok) return res.status(resolved.status).json(resolved.body);
    const { offerId, brandId, pricing, headers, row } = resolved.scope;

    const payload = await computeOfferPipelineActivity(req as never, {
      offerId,
      brandId,
      pricing,
      channels: row.channels,
      funnelKey: row.funnelKey,
      headers: { orgId: headers.orgId, userId: headers.userId ?? "", runId: headers.runId ?? "" },
    });
    if (!payload.ok) return res.status(payload.status).json(payload.body);
    res.json({ offerId, funnelKey: row.funnelKey, channels: describeChannels(row), ...payload.body });
  } catch (error) {
    if (handleScopeError(error, res)) return;
    console.error("[features-service] Offer funnel pipeline activity error:", error);
    res.status(502).json({ error: "Failed to compute offer funnel pipeline activity" });
  }
});

export default router;
