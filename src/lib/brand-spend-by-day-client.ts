/**
 * ONE BRAND'S COMMITTED spend, dated by UTC day — the time axis `costEconomics.committedCostUsd`
 * has never had.
 *
 * Reads runs-service `GET /v1/stats/public/costs/timeseries`, the SAME dated-cost endpoint the
 * cross-org trend surfaces use, narrowed to one org + one brand (+ one campaign when the caller is
 * campaign-scoped) and to the feature's workflow lineage. runs documents the reconciliation
 * invariant explicitly — summing the buckets for a filter equals the untimed total from the plain
 * cost aggregation for that same filter — so the LAST cumulative point of a series built on this is
 * the same dollar figure `fetchRunsCostCents` returns for the same basis, and the dated ROI curve
 * terminates exactly on the headline ROI. That is the whole reason this reads the same aggregator instead of estimating a
 * daily shape from anything else.
 *
 * COMMITTED, because this service has exactly ONE spend basis and every money figure derived from
 * run spend rides it (see cost-economics.ts). So this reads `totalCostInUsdCents` — and its FROZEN
 * NET twin `netTotalCostInUsdCents` under `?pricing=net`, exactly like every other cost read here: no
 * read-time discount multiply, no billing call, and a NET request that finds no net twin fails loud
 * rather than quietly charting full price under a discount banner. Reading the billed-only field here
 * would put the ROI chart on a different basis from the ROI card directly above it.
 *
 * The endpoint takes no auth; the api-key is sent for parity with the other runs reads. Fail-loud on
 * transport / non-OK / malformed body — the caller decides whether to degrade (the /revenue Overview
 * wraps it fail-SOFT, because a missing curve must never 502 an Overview whose every other number
 * is correct).
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { Pricing } from "./pricing.js";
import { campaignScopeIds, type CampaignFilter } from "./campaign-scope.js";
import { featureSlugsParam, type FeatureScope } from "./feature-scope.js";

/**
 * How many of a campaign IDENTITY's members are read at once. runs takes ONE campaign and the
 * timeseries route offers no `groupBy`, so a family is read member by member; the cap is the repo's
 * standard fan-out bound, sized so a 51-member identity (the largest in production, 2026-09-17)
 * cannot burst fifty simultaneous sockets at runs-service.
 */
export const SPEND_BY_DAY_MEMBER_CONCURRENCY = 6;

/**
 * ONE campaign filter's dated spend — the single `GET /costs/timeseries` read every scope is built
 * from. `campaignId` undefined = the whole brand+feature scope.
 *
 * @returns Map<YYYY-MM-DD, committed spend in USD for that day>. Days with no runs are ABSENT (runs
 * never fabricates an empty bucket) — a consumer treats an absent day as zero spend, which it is.
 */
async function fetchDatedSpendForCampaign(
  brandId: string,
  campaignId: string | undefined,
  featureScope: FeatureScope,
  headers: { orgId: string },
  pricing: Pricing,
  workflowDynastySlug: string | undefined,
): Promise<Map<string, number>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({
    interval: "day",
    featureSlugs: featureSlugsParam(featureScope),
    orgId: headers.orgId,
    brandId,
  });
  if (campaignId) params.set("campaignId", campaignId);
  if (workflowDynastySlug) params.set("workflowDynastySlug", workflowDynastySlug);

  const response = await fetchWithRetry(`${url}/v1/stats/public/costs/timeseries?${params}`, {
    headers: { "x-api-key": apiKey },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `runs-service /v1/stats/public/costs/timeseries failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as {
    buckets?: Array<Record<string, unknown> & { period?: unknown }>;
  };
  if (!Array.isArray(data.buckets)) {
    throw new Error("runs-service costs/timeseries returned no buckets array");
  }

  const field = pricing === "net" ? "netTotalCostInUsdCents" : "totalCostInUsdCents";
  const byDay = new Map<string, number>();
  for (const bucket of data.buckets) {
    if (typeof bucket.period !== "string") {
      throw new Error("runs-service costs/timeseries bucket missing period");
    }
    const raw = bucket[field];
    // NET never silently falls back to GROSS: showing undiscounted money under a discount banner is
    // the exact failure the frozen-net contract exists to prevent.
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new Error(`runs-service costs/timeseries bucket missing ${field}`);
    }
    const cents = Number(raw);
    if (!Number.isFinite(cents)) {
      throw new Error(`runs-service costs/timeseries bucket has non-numeric ${field}`);
    }
    const day = bucket.period.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + cents / 100);
  }
  return byDay;
}

/**
 * THE SCOPE'S OWN dated COMMITTED spend — narrowed by exactly the campaigns every other money figure
 * on the same body is narrowed by.
 *
 * ── WHY A FAMILY IS READ MEMBER BY MEMBER ────────────────────────────────────────────────────────
 *
 * A campaign as a customer knows it arrives here as MANY stored rows sharing one identity
 * (campaign-identity.ts), and runs' timeseries route takes ONE `campaignId` with no `groupBy` — so
 * the untimed read's trick of co-grouping `campaignId` and summing locally is unavailable. Until
 * 2026-09-17 the family therefore fell back to the BRAND's curve, i.e. the spend leg silently did not
 * narrow while `costEconomics.committedCostUsd`, `outcomes.committedSpentCents` and the `spend` block
 * all did. Measured in prod on brand `f4d73dab…` / campaign `647572d9…` (org `f0420eb5…`, 51 members):
 * the body stated **$369.32** three times over and its return curve terminated at **$1,342.38**, the
 * other identities' spend under this campaign's name — and once #980 shipped, a cost-per-outcome curve
 * drawn from the same map printed **$16.57** beneath a stat row reading **$4.56** for the same outcome
 * on the same campaign.
 *
 * Summing members is EXACT, not an approximation: a cost row belongs to exactly ONE campaign, so the
 * union double-counts nobody — the byte-same additivity `/audience-stats` relies on when it reads
 * email-gateway once per member. What is NOT additive is people, and no count is read here.
 *
 * ── WHAT DOES NOT MOVE ───────────────────────────────────────────────────────────────────────────
 *
 * A brand-wide read (`undefined`) and a one-member scope issue the IDENTICAL single request they
 * always did — same URL, same params — so every figure they serve is byte-unchanged. Only a genuine
 * multi-member family takes the fan-out, capped at {@link SPEND_BY_DAY_MEMBER_CONCURRENCY}.
 *
 * A scope whose members recorded no spend answers an EMPTY map — a measured "this scope has spent
 * nothing", never a fall back to the brand's wider curve. The caller renders that as a curve with no
 * priced point rather than as another scope's money.
 *
 * FAIL-LOUD per member (any rejection propagates, as `Promise.all` would): a partial sum is a
 * silently under-stated spend leg, which would make the curve read cheaper than the scope really is.
 * The /revenue Overview wraps the whole read fail-SOFT, so a failure nulls the curves rather than
 * 502-ing a page whose every other figure is right.
 *
 * (features-service#983.)
 *
 * @returns Map<YYYY-MM-DD, committed spend in USD for that day>. Days with no runs are ABSENT (runs
 * never fabricates an empty bucket) — a consumer treats an absent day as zero spend, which it is.
 */
export async function fetchBrandCommittedSpendByDay(
  brandId: string,
  campaignScope: CampaignFilter,
  // ONE channel, or the SET an offer is sold through (lib/feature-scope.ts). The timeseries route
  // comma-splits `featureSlugs` exactly as the untimed cost read does, so the sum-equals-total
  // invariant holds across a multi-channel scope too.
  featureScope: FeatureScope,
  headers: { orgId: string },
  pricing: Pricing = "gross",
  // ONE WORKFLOW DYNASTY, when the read is drilled into one (`?workflow=`, lib/workflow-scope.ts).
  // The timeseries route resolves it to its versioned slugs through workflow-service, so the curve's
  // spend leg is narrowed by the SAME catalogue the untimed total is. Omitted → today's curve.
  workflowDynastySlug?: string,
): Promise<Map<string, number>> {
  const members = campaignScopeIds(campaignScope);

  // The brand-wide and single-campaign paths are the original ONE request, unchanged.
  if (members.length <= 1) {
    return fetchDatedSpendForCampaign(
      brandId,
      members[0],
      featureScope,
      headers,
      pricing,
      workflowDynastySlug,
    );
  }

  const perMember = await mapWithConcurrency(members, SPEND_BY_DAY_MEMBER_CONCURRENCY, (campaignId) =>
    fetchDatedSpendForCampaign(brandId, campaignId, featureScope, headers, pricing, workflowDynastySlug),
  );

  const byDay = new Map<string, number>();
  for (const memberDays of perMember) {
    for (const [day, usd] of memberDays) {
      byDay.set(day, (byDay.get(day) ?? 0) + usd);
    }
  }
  return byDay;
}
