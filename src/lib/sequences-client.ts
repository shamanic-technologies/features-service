import { fetchWithRetry } from "./fetch-retry.js";
import type { SignalSeries } from "./revenue-engine.js";
import { mapWithConcurrency } from "./concurrency.js";
import { campaignFamilySet, singleCampaignId, type CampaignFilter } from "./campaign-scope.js";

/**
 * Per-day OUTREACH ACTIVITY series for the Overview graph — sourced from instantly's campaign-created
 * count via email-gateway `GET /orgs/stats?type=broadcast&groupBy=day`, NOT the lead snapshot.
 *
 * WHY this exists alongside `recipientsContacted` (features-service#415). `recipientsContacted` counts each
 * lead ONCE, bucketed by its FIRST-ever contact date for the brand (the funnel view — "who are my leads,
 * how far did each get"). That structurally UNDER-counts daily outreach when a brand re-contacts leads it
 * already emailed: a lead re-contacted today under a new campaign back-dates to its first-contact month,
 * so "outreach today" showed 3 while 34 campaigns were launched + ~$4.60 spent today. This series answers
 * the OTHER question — "how much outreach happened each day" — by counting instantly campaigns created per
 * day (one per lead served that day, incl. re-contacts). It matches "budget spent today" by construction.
 *
 * Grain difference from `recipientsContacted` is intentional and the two are NOT reconciled: the card total
 * = distinct leads reached (unique), the graph bar = outreach actions per day (events). Each is internally
 * coherent; they legitimately differ. Do NOT try to make sum(daily) === recipientsContacted.total.
 *
 * `undatedCount` is always 0 — instantly buckets every campaign by its `created_at` day (no undated case).
 * Timezone is fixed UTC so the buckets align with the UTC calendar days the other actual series use.
 *
 * OVERVIEW-ONLY, fail-soft: this is display enrichment, not the pipeline total. The caller degrades a
 * failure to `null` (the graph falls back to no outreach bars) rather than 502-ing the whole /revenue
 * response — mirrors the email-gateway timestamp overlay. Fails loud only on missing config.
 */
export async function fetchSequencesByDay(
  brandId: string,
  // One campaign, or the family sharing one identity (see campaign-identity.ts). email-gateway's
  // `groupBy` is single-dimension, so a family cannot be split per (day × campaign) in one call:
  // its members are read separately (capped concurrency) and their day buckets summed. Summing is
  // exact here — the series counts SENDS, and a send belongs to exactly one campaign.
  campaignScope: CampaignFilter,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<SignalSeries> {
  const family = campaignFamilySet(campaignScope);
  if (family) {
    const perMember = await mapWithConcurrency([...family], 6, (id) =>
      fetchSequencesByDay(brandId, id, featureSlug, headers),
    );
    const byDate = new Map<string, number>();
    for (const series of perMember) {
      for (const point of series.daily) byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.count);
    }
    const daily = [...byDate]
      .map(([date, count]) => ({ date, count }))
      .filter((point) => point.count > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { total: daily.reduce((sum, p) => sum + p.count, 0), daily, undatedCount: 0 };
  }
  const campaignId = singleCampaignId(campaignScope);

  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({
    type: "broadcast",
    groupBy: "day",
    brandId,
    featureSlugs: featureSlug,
    timezone: "UTC",
  });
  // campaignId narrows the same brand-scoped day series to one campaign (mirrors the other overview reads).
  if (campaignId) params.set("campaignId", campaignId);

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
    "x-feature-slug": featureSlug,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;

  const response = await fetchWithRetry(`${url}/orgs/stats?${params}`, { headers: reqHeaders });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/stats daily broadcast failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    groups?: Array<{ key?: string; broadcast?: { recipientStats?: { contacted?: number } } }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("email-gateway /orgs/stats daily broadcast returned no groups array");
  }

  const daily = data.groups
    .map((group) => {
      const contacted = group.broadcast?.recipientStats?.contacted;
      if (typeof group.key !== "string" || typeof contacted !== "number" || !Number.isFinite(contacted)) {
        throw new Error(`email-gateway day group ${group.key} missing numeric recipientStats.contacted`);
      }
      return { date: group.key, count: contacted };
    })
    .filter((point) => point.count > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const total = daily.reduce((sum, point) => sum + point.count, 0);
  return { total, daily, undatedCount: 0 };
}
