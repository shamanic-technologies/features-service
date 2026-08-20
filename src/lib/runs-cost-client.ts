/**
 * Run spend (USD cents) for a brand (+ optional campaign), scoped to one feature's workflow lineage,
 * on BOTH accounting bases in ONE read.
 *
 * THIS SERVICE HAS EXACTLY ONE SPEND BASIS, AND IT IS COMMITTED. `committedCents` sums
 * `totalCostInUsdCents` (billed `actual` + the open `provisioned` holds) and is what every money
 * figure derived from run spend divides by — ROI, %CAC, cost per acquisition, cost per conversion,
 * the spend figure a consumer renders as "$ Invested", the ROI-history spend leg, and the `spend`
 * block's cost-per-outcome columns (which were already committed). Splitting the basis is what made
 * one payload answer "how much did this cost" two ways at once: the brand Overview showed the
 * committed total while the campaigns table showed billed-only, so one brand with one campaign read
 * $202 in one place and $191 in the other.
 *
 * `actualCents` (billed only) is still returned so `costEconomics.actualCostUsd` stays populated and
 * honest through the consumer transition — it is NOT a second basis any ratio rides. Do NOT
 * reintroduce one, and do NOT add a query parameter to pick between them.
 *
 * runs-service resolves `featureSlugs` → the feature's workflow lineage server-side; we sum across
 * the workflow groups. Both fields ride the SAME group, so this costs no extra IO.
 *
 * Fail-loud: a swallowed runs error would fake $0 cost → fake "0% cost-of-acquisition /
 * null ROI" business numbers. So any transport / non-OK / malformed response throws and the
 * caller returns 502. This intentionally diverges from /stats's fetchRunsStats (fail-soft to
 * 0) — the revenue path treats cost as a core output, like its leads / economics clients.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { selectCostCents, type Pricing } from "./pricing.js";
import { campaignFamilySet, singleCampaignId, type CampaignFilter } from "./campaign-scope.js";
import { featureSlugsParam, type FeatureScope } from "./feature-scope.js";

/**
 * One scope's run spend on both bases. `committedCents` is THE basis (see the module header);
 * `actualCents` exists only to keep the transitional `costEconomics.actualCostUsd` honest.
 */
export interface RunsCostCents {
  /** `totalCostInUsdCents` — billed + open holds. The single basis every derived money figure rides. */
  committedCents: number;
  /** `actualCostInUsdCents` — billed only. Reported, never divided by. */
  actualCents: number;
}

export async function fetchRunsCostCents(
  brandId: string,
  // One campaign, or the family of campaigns sharing one identity. A single-campaign scope keeps
  // the original `campaignId=` filter; a family co-groups on campaignId and sums its members, so
  // the whole family costs ONE runs call regardless of how many stopped rows it carries.
  campaignScope: CampaignFilter,
  // ONE channel, or the SET of channels an offer is sold through (see lib/feature-scope.ts).
  // runs-service comma-splits `featureSlugs`, so several channels cost one call and a run — which
  // carries exactly one `feature_slug` — can never be counted twice.
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
  // NET pricing: read runs-service's FROZEN net twins (`netTotalCostInUsdCents` /
  // `netActualCostInUsdCents`) instead of the gross fields (runs#179 freezes each row's discount at
  // write time — no read-time multiply here). GROSS (the default) reads the gross fields →
  // byte-identical. Every downstream metric (CAC, ROI, CPC) derives from this, so it comes out net +
  // coherent by construction. A NET read never falls back to gross: `selectCostCents` throws.
  pricing: Pricing = "gross",
): Promise<RunsCostCents> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const campaignId = singleCampaignId(campaignScope);
  const family = campaignFamilySet(campaignScope);

  // Mirror /stats: group by workflowSlug, scope to the feature lineage, sum the groups. A family
  // co-groups campaignId so its members can be summed here — runs takes no campaign list.
  const params = new URLSearchParams({
    groupBy: family ? "workflowSlug,campaignId" : "workflowSlug",
    brandId,
    featureSlugs: featureSlugsParam(featureScope),
  });
  if (campaignId) params.set("campaignId", campaignId);

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/v1/stats/costs?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    groups?: Array<Record<string, unknown> & { dimensions?: Record<string, string | null> }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }

  let committedCents = 0;
  let actualCents = 0;
  for (const group of data.groups) {
    if (family) {
      const cid = group.dimensions?.campaignId;
      if (!cid || !family.has(cid)) continue;
    }
    committedCents += Math.round(selectCostCents(group, "totalCostInUsdCents", pricing));
    actualCents += Math.round(selectCostCents(group, "actualCostInUsdCents", pricing));
  }
  return { committedCents, actualCents };
}

/**
 * The SAME brand+feature spend `fetchRunsCostCents` sums, on the SAME two bases, kept SPLIT per versioned
 * `workflowSlug` instead of totalled — the cost leg of `GET /revenue?groupBy=workflow`.
 *
 * It is deliberately the identical request (`groupBy=workflowSlug`, same brand + feature-lineage
 * filter, same `selectCostCents` gross/net selection, same per-group rounding); only the final `+=`
 * differs. So Σ over every slug here IS the number the brand read reports, to the cent, and a brand
 * whose spend all sits on one workflow reads the same figure at both grains by construction rather
 * than by a correction.
 *
 * Brand-wide only (no campaign scope): the workflow grain answers "of everything we ran for this
 * brand, which workflows made money", which is the brand's whole spend.
 *
 * Fail-loud, for the same reason as its sibling: a swallowed error would fake $0 cost and print an
 * infinite ROI for a workflow that burned money.
 */
export async function fetchRunsCostCentsByWorkflowSlug(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
  pricing: Pricing = "gross",
): Promise<Map<string, RunsCostCents>> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ groupBy: "workflowSlug", brandId, featureSlugs: featureSlug });

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/v1/stats/costs?${params}`, { headers: reqHeaders });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=workflowSlug) failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    groups?: Array<Record<string, unknown> & { dimensions?: Record<string, string | null> }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }

  const bySlug = new Map<string, RunsCostCents>();
  // Spend runs-service could not attribute to a workflow at all. It belongs to no workflow, so it is
  // reported to NO group rather than parked on one — and said out loud, because it is the one thing
  // that can make the groups sum to less than the brand total.
  let unattributedCommittedCents = 0;
  for (const group of data.groups) {
    const committedCents = Math.round(selectCostCents(group, "totalCostInUsdCents", pricing));
    const actualCents = Math.round(selectCostCents(group, "actualCostInUsdCents", pricing));
    const slug = group.dimensions?.workflowSlug;
    if (!slug || slug === "__total__") {
      unattributedCommittedCents += committedCents;
      continue;
    }
    const prev = bySlug.get(slug);
    bySlug.set(slug, {
      committedCents: (prev?.committedCents ?? 0) + committedCents,
      actualCents: (prev?.actualCents ?? 0) + actualCents,
    });
  }
  if (unattributedCommittedCents !== 0) {
    console.warn(
      `[features-service] ${unattributedCommittedCents} committed cents of ${brandId}'s ${featureSlug} spend carry no workflow and are in no per-workflow group`,
    );
  }
  return bySlug;
}

/**
 * Enumerate the campaignIds that have runs for a brand, scoped to one feature's workflow
 * lineage — the same runs-service source `/stats` uses for its campaignId dimension. Drives
 * GET /features/:slug/revenue?groupBy=campaignId: one group per campaign returned here.
 *
 * Uses `groupBy=campaignId` (vs fetchRunsCostCents's `groupBy=workflowSlug`) purely to read
 * the campaign KEYS — the per-campaign cost is recomputed by the existing fetchRunsCostCents
 * so each group's costEconomics is byte-equal to the standalone campaignId-scoped call.
 *
 * Fail-loud: a swallowed error would silently drop campaigns from the grouped response.
 */
export async function fetchCampaignIdsWithRuns(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<string[]> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ groupBy: "campaignId", brandId, featureSlugs: featureSlug });

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/v1/stats/costs?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=campaignId) failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { groups?: Array<{ dimensions?: Record<string, string | null> }> };
  if (!Array.isArray(data.groups)) {
    throw new Error("runs-service /v1/stats/costs returned no groups array");
  }

  const ids = new Set<string>();
  for (const group of data.groups) {
    const campaignId = group.dimensions?.campaignId;
    if (campaignId) ids.add(campaignId);
  }
  return [...ids];
}
