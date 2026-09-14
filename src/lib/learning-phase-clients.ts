/**
 * The two reads the learning verdict needs and no other surface here makes.
 *
 *  - PER-CAMPAIGN driver counts, so every campaign of a scope states its own outcome count and the
 *    verdict can say which one leads. ONE call per acquisition channel for the whole brand, NOT one
 *    per campaign: `groupBy=campaignId` answers for every campaign at once.
 *  - PER-CAMPAIGN COMMITTED SPEND, on the same basis and from the same ledger the money block above it
 *    rides, so "spent X of a Y target" can never contradict the "Invested X" beside it.
 *  - THE LEG'S DAILY CEILING, so the countdown has a rate to divide the remaining spend by — and so
 *    "what would raising it buy" can be answered in the same unit.
 *
 * Both FAIL LOUD; the caller wraps them soft, because the verdict is display enrichment on a body
 * whose every other figure is already correct. A degraded read produces a NAMED `unmeasured` reason,
 * never a fabricated count and never a zero.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { featureSlugList, featureSlugsParam, soleFeatureSlug, type FeatureScope } from "./feature-scope.js";
import { selectCostCents, type Pricing } from "./pricing.js";

/** The two counted signals a grain observes, for ONE campaign id. */
export interface CampaignDriverCounts {
  clicks: number;
  replies: number;
}

function emailHeaders(brandId: string, headers: { orgId: string; userId?: string; runId?: string }): Record<string, string> {
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!apiKey) throw new Error("EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  return h;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Every campaign's raw click + positive-reply counts for one (brand, channel set).
 *
 * `groupBy=campaignId` is single-dimension, so a multi-channel scope is read ONCE PER CHANNEL and the
 * per-campaign counts ADDED — exact, because a send carries exactly one feature slug and exactly one
 * campaign, so no recipient is counted twice. The same reason `fetchSequencesByDay` may add its day
 * buckets, and the same reason the per-campaign figures are a SUBSET of the brand's rather than a
 * correction applied afterwards.
 *
 * A campaign with no sends is ABSENT from the map. The caller reads that as a measured 0 for a campaign
 * it knows exists, which is what it is — the producer emits a bucket only for a campaign that sent.
 */
export async function fetchCampaignDriverCounts(
  brandId: string,
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<Map<string, CampaignDriverCounts>> {
  const baseUrl = process.env.EMAIL_GATEWAY_SERVICE_URL;
  if (!baseUrl) throw new Error("EMAIL_GATEWAY_SERVICE_URL not configured");

  const perChannel = await mapWithConcurrency(featureSlugList(featureScope), 4, async (featureSlug) => {
    const params = new URLSearchParams({
      type: "broadcast",
      groupBy: "campaignId",
      brandId,
      featureSlugs: featureSlug,
    });
    const response = await fetchWithRetry(`${baseUrl}/orgs/stats?${params}`, {
      headers: emailHeaders(brandId, headers),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`email-gateway /orgs/stats (groupBy=campaignId) failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { groups?: Array<Record<string, unknown>> };
    return Array.isArray(data.groups) ? data.groups : [];
  });

  const result = new Map<string, CampaignDriverCounts>();
  for (const groups of perChannel) {
    for (const group of groups) {
      const key = group.key == null ? null : String(group.key);
      if (!key) continue;
      const broadcast = group.broadcast as Record<string, unknown> | undefined;
      const stats = broadcast?.recipientStats as Record<string, unknown> | undefined;
      if (!stats) continue;
      const existing = result.get(key) ?? { clicks: 0, replies: 0 };
      existing.clicks += readCount(stats.clicked);
      existing.replies += readCount(stats.repliesPositive);
      result.set(key, existing);
    }
  }
  return result;
}

/**
 * WHAT BILLING HAS THIS LEG FUNDED AT, per day, in dollars.
 *
 * A campaign is (brand, offer, acquisition channel, LEG), so this is the money that paces one campaign,
 * read on the same key the campaign is keyed on. `null` is "this leg has no ceiling" — billing states
 * that explicitly and it is a DIFFERENT answer from a ceiling of 0, so it is never derived from one.
 */
export async function fetchLegDailyCeilingUsd(
  brandId: string,
  legKey: string,
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<number | null> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");

  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  // Attribution only — the ceiling is funded per (brand, leg) and the slug never reaches the path. At a
  // grain spanning several channels naming one of them would attribute the read to a channel nobody asked
  // about, so it is omitted there.
  const featureSlug = soleFeatureSlug(featureScope);
  if (featureSlug) h["x-feature-slug"] = featureSlug;

  const path = `/internal/brands/${encodeURIComponent(brandId)}/legs/${encodeURIComponent(legKey)}/daily-budget`;
  const response = await fetchWithRetry(`${url}${path}`, { headers: h });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`billing-service ${path} failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { dailyBudgetCents?: string | number | null };
  const raw = data.dailyBudgetCents;
  if (raw == null) return null;
  const cents = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents / 100;
}

/**
 * EVERY campaign's COMMITTED spend cents for one (brand, channel set) — `groupBy=campaignId`, so it is
 * ONE call for the whole brand rather than one per campaign.
 *
 * WHY THIS RATHER THAN SUMMING THE (campaign × workflow) CELLS. Those cells are rolled up by workflow
 * DYNASTY, and `buildWorkflowDynasties` keys on the ACTIVE version — so spend a campaign made on a
 * lineage that has since been retired is absent from them. Summing them therefore UNDER-states what the
 * campaign has committed, and the countdown would then sit on this body beside a `costEconomics`
 * figure that disagrees with it. Measured in prod on the campaign this feature was built for: the
 * dynasty-rolled cells came to **$790.53** against the ledger's **$850.35** — $59.82 on retired
 * lineages, two numbers about one campaign's money under one body. The cells price ONE outcome (and
 * are right to exclude a lineage that produced none); the ledger says what has been SPENT.
 *
 * COMMITTED (actual + holds), the one basis every money figure on this service rides, and it takes the
 * caller's `pricing` so a NET read divides a net target by net spend.
 */
export async function fetchCampaignCommittedCents(
  brandId: string,
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
  pricing: Pricing,
): Promise<Map<string, number>> {
  const baseUrl = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");

  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;

  const params = new URLSearchParams({
    groupBy: "campaignId",
    brandId,
    featureSlugs: featureSlugsParam(featureScope),
  });
  const response = await fetchWithRetry(`${baseUrl}/v1/stats/costs?${params}`, { headers: h });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`runs-service /v1/stats/costs (groupBy=campaignId) failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as { groups?: Array<{ dimensions?: Record<string, string | null> }> };
  const result = new Map<string, number>();
  if (!Array.isArray(data.groups)) return result;
  for (const group of data.groups) {
    const campaignId = group.dimensions?.campaignId;
    if (!campaignId) continue;
    const cents = selectCostCents(group, "totalCostInUsdCents", pricing);
    if (!Number.isFinite(cents)) continue;
    result.set(campaignId, (result.get(campaignId) ?? 0) + cents);
  }
  return result;
}
