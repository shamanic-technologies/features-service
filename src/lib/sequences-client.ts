import { campaignFamilyStatsParams } from "./email-gateway-family.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { SignalSeries } from "./revenue-engine.js";
import { mapWithConcurrency } from "./concurrency.js";
import { campaignFamilySet, singleCampaignId, type CampaignFilter } from "./campaign-scope.js";
import { featureSlugList, type FeatureScope } from "./feature-scope.js";

/** One broadcast day group as email-gateway serves it on `groupBy=day`. */
interface BroadcastDayGroup {
  key?: string;
  broadcast?: {
    recipientStats?: { contacted?: number };
    emailStats?: { sent?: number; delivered?: number; bounced?: number };
  };
}

/** Per-day counts, keyed by UTC date. Summing two maps is exact: a send carries one campaign + one feature. */
type DayCounts<K extends string> = Map<string, Record<K, number>>;

function addDayCounts<K extends string>(parts: DayCounts<K>[]): DayCounts<K> {
  const out: DayCounts<K> = new Map();
  for (const part of parts) {
    for (const [date, counts] of part) {
      const acc = out.get(date);
      if (!acc) {
        out.set(date, { ...counts });
        continue;
      }
      for (const k of Object.keys(counts) as K[]) acc[k] += counts[k];
    }
  }
  return out;
}

/**
 * THE ONE email-gateway `GET /orgs/stats?type=broadcast&groupBy=day` read every per-day broadcast
 * series here is built from, over a scope (one channel or a set, one campaign or a family). `read`
 * turns one day group into the counts the caller wants and THROWS when a field it needs is absent —
 * a series is never drawn from a missing number.
 */
async function fetchBroadcastDays<K extends string>(
  brandId: string,
  campaignScope: CampaignFilter,
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
  workflowSlugs: string | undefined,
  read: (group: BroadcastDayGroup) => Record<K, number>,
): Promise<DayCounts<K>> {
  const slugs = featureSlugList(featureScope);
  if (slugs.length > 1) {
    return addDayCounts(
      await mapWithConcurrency(slugs, 4, (slug) => fetchBroadcastDays(brandId, campaignScope, slug, headers, workflowSlugs, read)),
    );
  }
  const featureSlug = slugs[0];
  const family = campaignFamilySet(campaignScope);
  const campaignId = singleCampaignId(campaignScope);
  // A FAMILY is ONE `campaignIds` request (email-gateway v0.27.2 sums the per-member day series
  // server-side, lib/email-gateway-family.ts) — chunked only above the producer's cap.
  const familyScopes = family ? campaignFamilyStatsParams([...family]) : [];
  if (familyScopes.length > 1) {
    return addDayCounts(
      await mapWithConcurrency(familyScopes, 6, (scope) =>
        fetchBroadcastDays(brandId, scope.campaignId ?? scope.campaignIds!.split(","), featureSlug, headers, workflowSlugs, read),
      ),
    );
  }
  const familyScope = familyScopes[0];

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
  if (familyScope) {
    for (const [k, v] of Object.entries(familyScope)) params.set(k, v);
  } else if (campaignId) {
    params.set("campaignId", campaignId);
  }
  if (workflowSlugs) params.set("workflowSlugs", workflowSlugs);

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

  const data = (await response.json()) as { groups?: BroadcastDayGroup[] };
  if (!Array.isArray(data.groups)) {
    throw new Error("email-gateway /orgs/stats daily broadcast returned no groups array");
  }
  const out: DayCounts<K> = new Map();
  for (const group of data.groups) {
    if (typeof group.key !== "string") throw new Error("email-gateway day group missing its date key");
    out.set(group.key, read(group));
  }
  return out;
}

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
  // ONE channel, or the SET an offer is sold through (lib/feature-scope.ts). A multi-channel scope is
  // read ONCE PER CHANNEL and the day buckets are added — deliberately NOT a comma-joined
  // `featureSlugs`, because unlike runs-service that plural has not been verified to comma-split here,
  // and a filter that silently matched nothing would draw an empty graph rather than fail. Adding is
  // exact for the same reason the family path adds: a send carries exactly one feature slug.
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
  // ONE WORKFLOW DYNASTY, when the read is drilled into one — as its VERSIONED slugs, comma-separated
  // (`WorkflowScope.producerSlugs`). NOT email-gateway's `workflowDynastySlug` lever, which it
  // resolves through workflow-service and which 502s on a dynasty that service does not describe.
  // Omitted → the whole scope → today's series.
  workflowSlugs?: string,
): Promise<SignalSeries> {
  const byDay = await fetchBroadcastDays(brandId, campaignScope, featureScope, headers, workflowSlugs, (group) => {
    const contacted = group.broadcast?.recipientStats?.contacted;
    if (typeof contacted !== "number" || !Number.isFinite(contacted)) {
      throw new Error(`email-gateway day group ${group.key} missing numeric recipientStats.contacted`);
    }
    return { contacted };
  });
  const daily = [...byDay]
    .map(([date, counts]) => ({ date, count: counts.contacted }))
    .filter((point) => point.count > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const total = daily.reduce((sum, point) => sum + point.count, 0);
  return { total, daily, undatedCount: 0 };
}

/**
 * EMAILS (not leads) sent, delivered and bounced per UTC day over the scope — email-gateway's
 * `emailStats` on the same day read `sequences` rides, every step counted. A day is the day the
 * EVENT happened (a bounce lands on the day it bounced), so a day's `delivered` is not that day's
 * `sent − bounced`; each number is the producer's own. Days with no group are absent (zero).
 * Fail-loud: the caller decides whether to degrade.
 */
export async function fetchBroadcastEmailsByDay(
  brandId: string,
  campaignScope: CampaignFilter,
  featureScope: FeatureScope,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<Map<string, { sent: number; delivered: number; bounced: number }>> {
  return fetchBroadcastDays(brandId, campaignScope, featureScope, headers, undefined, (group) => {
    const stats = group.broadcast?.emailStats;
    const num = (v: unknown, name: string): number => {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`email-gateway day group ${group.key} missing numeric emailStats.${name}`);
      }
      return v;
    };
    return { sent: num(stats?.sent, "sent"), delivered: num(stats?.delivered, "delivered"), bounced: num(stats?.bounced, "bounced") };
  });
}
