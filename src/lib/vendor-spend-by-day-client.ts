/**
 * ONE SCOPE'S dated spend on the VENDOR basis — what running it really cost us, before our markup.
 * The staff-only twin of `fetchBrandCommittedSpendByDay` (lib/actual-cost-history.ts says why it is
 * never reachable from a customer read).
 *
 * Reads runs-service `GET /internal/stats/costs/timeseries/vendor` — SERVICE-AUTH, and deliberately
 * not the no-auth public timeseries the billed curve reads, because the vendor figure is our margin.
 * Same filters as the billed read (org, brand, feature slug(s), campaign / campaign family, workflow
 * dynasty, startedAfter), so the two curves describe the same rows.
 *
 * runs-service prices each row through costs-service's own statement of what that price version cost
 * us (the markup changed over time, some vendors add non-recoverable VAT, pass-through lines carry no
 * markup), and states the BILLED amount of the rows it could not price separately. This client keeps
 * the two apart: `vendorUsd` for the priced rows, `unpricedBilledUsd` for the rest — never folded.
 *
 * WHICH ROWS. The billed curve divides by COMMITTED spend (actual + provisioned). The vendor curve
 * reads the same committed rows PLUS the refunded ones: a row we comped was still paid to the vendor,
 * and "what it really cost us" must not drop money we spent because we chose not to bill it.
 *
 * Fail-loud on transport / non-OK / malformed body; the /revenue compute already wraps the dated
 * spend fail-SOFT, so a failure nulls the curve rather than 502-ing.
 */

import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { campaignScopeIds } from "./campaign-scope.js";
import { runsFeatureSlugsParam } from "./feature-scope.js";
import { RUNS_CAMPAIGN_IDS_PER_REQUEST, SPEND_BY_DAY_MEMBER_CONCURRENCY } from "./brand-spend-by-day-client.js";
import type { DatedSpendReader, VendorSpendDay } from "./actual-cost-history.js";

/** The committed + comped rows' vendor cost, and the billed amount of those we could not price. */
const VENDOR_FIELDS = ["vendorTotalCostInUsdCents", "vendorRefundedCostInUsdCents"] as const;
const UNPRICED_FIELDS = ["unpricedTotalCostInUsdCents", "unpricedRefundedCostInUsdCents"] as const;

function cents(bucket: Record<string, unknown>, field: string): number {
  const raw = bucket[field];
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new Error(`runs-service vendor timeseries bucket missing ${field}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`runs-service vendor timeseries bucket has non-numeric ${field}`);
  return n;
}

async function fetchOne(
  brandId: string,
  campaign: string | readonly string[] | undefined,
  featureScope: Parameters<DatedSpendReader>[2],
  orgId: string,
  workflowDynastySlug: string | undefined,
  startedAfter: string | undefined,
): Promise<Map<string, VendorSpendDay>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");

  const params = new URLSearchParams({ interval: "day", featureSlugs: runsFeatureSlugsParam(featureScope), orgId, brandId });
  if (typeof campaign === "string") params.set("campaignId", campaign);
  else if (campaign) params.set("campaignIds", campaign.join(","));
  if (workflowDynastySlug) params.set("workflowDynastySlug", workflowDynastySlug);
  if (startedAfter) params.set("startedAfter", startedAfter);

  const response = await fetchWithRetry(`${url}/internal/stats/costs/timeseries/vendor?${params}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`runs-service /internal/stats/costs/timeseries/vendor failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { buckets?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.buckets)) throw new Error("runs-service vendor timeseries returned no buckets array");

  const byDay = new Map<string, VendorSpendDay>();
  for (const bucket of data.buckets) {
    if (typeof bucket.period !== "string") throw new Error("runs-service vendor timeseries bucket missing period");
    const day = bucket.period.slice(0, 10);
    const vendor = VENDOR_FIELDS.reduce((s, f) => s + cents(bucket, f), 0) / 100;
    const unpriced = UNPRICED_FIELDS.reduce((s, f) => s + cents(bucket, f), 0) / 100;
    const names = Array.isArray(bucket.unpricedCostNames) ? bucket.unpricedCostNames.filter((n): n is string => typeof n === "string") : [];
    byDay.set(day, merge(byDay.get(day), { vendorUsd: vendor, unpricedBilledUsd: unpriced, unpricedCostNames: names }));
  }
  return byDay;
}

function merge(prev: VendorSpendDay | undefined, next: VendorSpendDay): VendorSpendDay {
  if (!prev) return next;
  return {
    vendorUsd: prev.vendorUsd + next.vendorUsd,
    unpricedBilledUsd: prev.unpricedBilledUsd + next.unpricedBilledUsd,
    unpricedCostNames: [...new Set([...prev.unpricedCostNames, ...next.unpricedCostNames])].sort(),
  };
}

/**
 * Same scope semantics as `fetchBrandCommittedSpendByDay`: brand-wide or one campaign is ONE request, a
 * campaign family is one `campaignIds` request per 500 members, summed (a cost row belongs to exactly
 * one campaign, so the sum is exact). `pricing` is accepted for the reader signature and ignored: a
 * vendor cost has no discount basis.
 */
export async function fetchBrandVendorSpendByDay(
  ...[brandId, campaignScope, featureScope, headers, , workflowDynastySlug, startedAfter]: Parameters<DatedSpendReader>
): Promise<Map<string, VendorSpendDay>> {
  const members = campaignScopeIds(campaignScope);
  if (members.length <= 1) {
    return fetchOne(brandId, members[0], featureScope, headers.orgId, workflowDynastySlug, startedAfter);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < members.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) {
    chunks.push(members.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));
  }
  const parts = await mapWithConcurrency(chunks, SPEND_BY_DAY_MEMBER_CONCURRENCY, (chunk) =>
    fetchOne(brandId, chunk, featureScope, headers.orgId, workflowDynastySlug, startedAfter),
  );
  const byDay = new Map<string, VendorSpendDay>();
  for (const part of parts) {
    for (const [day, v] of part) byDay.set(day, merge(byDay.get(day), v));
  }
  return byDay;
}

/**
 * The FLEET twin: one workflow dynasty's dated vendor spend across EVERY org and brand of a feature —
 * the spend leg of the staff-only fleet per-workflow curve (`lib/fleet-workflow-return.ts`). Same
 * producer route and same fields as the per-brand read above, with no org / brand filter.
 */
export async function fetchDynastyVendorSpendByDay(
  featureSlug: string,
  workflowDynastySlug: string,
  // LEG scope, as on the billed twin: absent → the whole fleet (byte-identical), empty → nothing spent.
  campaignIds?: string[],
): Promise<Map<string, VendorSpendDay>> {
  if (campaignIds === undefined) return fetchDynastyVendorChunk(featureSlug, workflowDynastySlug, undefined);
  const byDay = new Map<string, VendorSpendDay>();
  for (let i = 0; i < campaignIds.length; i += RUNS_CAMPAIGN_IDS_PER_REQUEST) {
    const part = await fetchDynastyVendorChunk(featureSlug, workflowDynastySlug, campaignIds.slice(i, i + RUNS_CAMPAIGN_IDS_PER_REQUEST));
    for (const [day, v] of part) byDay.set(day, merge(byDay.get(day), v));
  }
  return byDay;
}

async function fetchDynastyVendorChunk(
  featureSlug: string,
  workflowDynastySlug: string,
  campaignIds: string[] | undefined,
): Promise<Map<string, VendorSpendDay>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({ interval: "day", featureSlugs: runsFeatureSlugsParam(featureSlug), workflowDynastySlug });
  if (campaignIds) params.set("campaignIds", campaignIds.join(","));
  const response = await fetchWithRetry(`${url}/internal/stats/costs/timeseries/vendor?${params}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`runs-service /internal/stats/costs/timeseries/vendor failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { buckets?: Array<Record<string, unknown>> };
  if (!Array.isArray(data.buckets)) throw new Error("runs-service vendor timeseries returned no buckets array");
  const byDay = new Map<string, VendorSpendDay>();
  for (const bucket of data.buckets) {
    if (typeof bucket.period !== "string") throw new Error("runs-service vendor timeseries bucket missing period");
    const day = bucket.period.slice(0, 10);
    const vendor = VENDOR_FIELDS.reduce((s, f) => s + cents(bucket, f), 0) / 100;
    const unpriced = UNPRICED_FIELDS.reduce((s, f) => s + cents(bucket, f), 0) / 100;
    const names = Array.isArray(bucket.unpricedCostNames) ? bucket.unpricedCostNames.filter((n): n is string => typeof n === "string") : [];
    byDay.set(day, merge(byDay.get(day), { vendorUsd: vendor, unpricedBilledUsd: unpriced, unpricedCostNames: names }));
  }
  return byDay;
}
