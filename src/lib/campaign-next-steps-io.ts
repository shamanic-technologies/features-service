/**
 * IO half of `campaign-next-steps.ts` (CAMPAIGN-NEXT-STEPS-1018): instantly-service's send queue (org-scoped) and
 * lead-service's first-message -> first-positive-reply latency on every channel (cross-org aggregate, grouped by campaign ids). Both FAIL LOUD (throw);
 * the route turns a failure into a named null, never a zero.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { assertReplyDelayCoherent, type ReplyDelayBucket, type ReplyDelayDistribution } from "./research/reply-delay.js";
import { parseEmailSendQueue, parseScheduledFollowups, type EmailSendQueue, type LatencyMetric, type ScheduledFollowups } from "./campaign-next-steps.js";

function instantlyBase(): { url: string; key: string } {
  const url = process.env.INSTANTLY_SERVICE_URL;
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!url || !key) throw new Error("INSTANTLY_SERVICE_URL / INSTANTLY_SERVICE_API_KEY not configured");
  return { url, key };
}

/** The org's email send queue over these campaigns (≤500 ids, instantly-service's cap). */
export async function fetchEmailSendQueue(orgId: string, campaignIds: string[]): Promise<EmailSendQueue> {
  if (campaignIds.length > 500) throw new Error(`send-queue: ${campaignIds.length} campaign ids exceed instantly-service's 500`);
  const { url, key } = instantlyBase();
  const params = new URLSearchParams({ campaignIds: campaignIds.join(",") });
  const res = await fetchWithRetry(`${url}/orgs/send-queue?${params}`, { headers: { "x-api-key": key, "x-org-id": orgId } });
  if (!res.ok) throw new Error(`instantly-service /orgs/send-queue failed (${res.status}): ${await res.text()}`);
  return parseEmailSendQueue(await res.json());
}

function readMetric(raw: unknown): LatencyMetric {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m.sampleSize !== "number") throw new Error("reply-latency: metric missing sampleSize");
  const n = (v: unknown): number | null => (v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : (() => { throw new Error("reply-latency: metric value is not a number"); })());
  return { averageMs: n(m.averageMs), medianMs: n(m.medianMs), sampleSize: m.sampleSize };
}

/**
 * First message -> first positive reply, per group of campaign ids, since inception, on EVERY channel (lead-service's
 * timeline: emails through any sender, WhatsApp, the follow-up writer's answers; REPLY-LATENCY-ALL-CHANNELS-1019).
 * Supersedes instantly-service's engagement latency, which saw only leads emailed and replying through Instantly, so a
 * pipe writing on another channel read "learning" forever. Cross-org (internal key, no org). Groups with no id are skipped.
 */
export async function fetchReplyLatencyByCampaignGroups(groups: Record<string, string[]>): Promise<Record<string, LatencyMetric>> {
  const body: Record<string, { campaignIds: string[] }> = {};
  for (const [k, ids] of Object.entries(groups)) if (ids.length > 0) body[k] = { campaignIds: ids };
  if (Object.keys(body).length === 0) return {};
  const url = process.env.LEAD_SERVICE_URL;
  const key = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !key) throw new Error("LEAD_SERVICE_URL / LEAD_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/internal/reply-latency/grouped`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ groups: body }),
  });
  if (!res.ok) throw new Error(`lead-service /internal/reply-latency/grouped failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { groups?: unknown };
  if (!Array.isArray(data.groups)) throw new Error("lead-service reply-latency/grouped returned no groups array");
  const out: Record<string, LatencyMetric> = {};
  for (const g of data.groups as Record<string, unknown>[]) out[String(g.key)] = readMetric(g.timeToFirstPositiveReply);
  return out;
}

/**
 * The same figure's SHAPE over one group of campaign ids (TTFPR-DISTRIBUTION-1021, the Research study "How long before
 * a first positive reply?"): sample, median, average, p10..p90 and the people per delay bucket with the running count,
 * read by lead-service's own names. Fails LOUD on a missing field (an older lead-service build) or an incoherent figure
 * (`assertReplyDelayCoherent`); never a partial distribution. ≤500 ids, lead-service's per-group cap: one group cannot
 * be split (percentiles do not add up across groups).
 */
export async function fetchReplyDelayDistribution(campaignIds: string[]): Promise<ReplyDelayDistribution> {
  if (campaignIds.length > 500) throw new Error(`reply-delay: ${campaignIds.length} campaign ids exceed lead-service's 500 per group`);
  const url = process.env.LEAD_SERVICE_URL;
  const key = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !key) throw new Error("LEAD_SERVICE_URL / LEAD_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/internal/reply-latency/grouped`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ groups: { fleet: { campaignIds } } }),
  });
  if (!res.ok) throw new Error(`lead-service /internal/reply-latency/grouped failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { groups?: unknown };
  if (!Array.isArray(data.groups)) throw new Error("lead-service reply-latency/grouped returned no groups array");
  const g = (data.groups as Record<string, unknown>[]).find((x) => x.key === "fleet");
  if (!g) throw new Error("lead-service reply-latency/grouped returned no fleet group");
  const raw = g.timeToFirstPositiveReply as Record<string, unknown> | null;
  const base = readMetric(raw);
  const pct = raw?.percentilesMs as Record<string, unknown> | undefined;
  if (!pct || typeof pct !== "object") throw new Error("reply-latency: percentilesMs missing (lead-service older than TTFPR-DISTRIBUTION-1021)");
  if (!Array.isArray(raw?.distribution)) throw new Error("reply-latency: distribution missing (lead-service older than TTFPR-DISTRIBUTION-1021)");
  if (!Array.isArray(raw?.dailyDistribution)) throw new Error("reply-latency: dailyDistribution missing (lead-service older than TTFPR-DAY-BINS-1021)");
  const num = (v: unknown, what: string): number | null => {
    if (v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`reply-latency: ${what} is not a number`);
    return v;
  };
  const bucketsOf = (list: unknown, what: string): ReplyDelayBucket[] =>
    (list as Record<string, unknown>[]).map((b, i) => {
      if (typeof b.key !== "string" || typeof b.label !== "string") throw new Error(`reply-latency: ${what} ${i} has no key/label`);
      const fromMs = num(b.fromMs, `${what} ${b.key} fromMs`);
      const count = num(b.count, `${what} ${b.key} count`);
      const cumulativeCount = num(b.cumulativeCount, `${what} ${b.key} cumulativeCount`);
      if (fromMs === null || count === null || cumulativeCount === null) throw new Error(`reply-latency: ${what} ${b.key} has a null bound or count`);
      return { key: b.key, label: b.label, fromMs, toMs: num(b.toMs, `${what} ${b.key} toMs`), count, cumulativeCount };
    });
  const distribution = bucketsOf(raw.distribution, "bucket");
  const dailyDistribution = bucketsOf(raw.dailyDistribution, "day bin");
  const out: ReplyDelayDistribution = {
    ...base,
    percentilesMs: { p10: num(pct.p10, "p10"), p25: num(pct.p25, "p25"), p50: num(pct.p50, "p50"), p75: num(pct.p75, "p75"), p90: num(pct.p90, "p90") },
    distribution,
    dailyDistribution,
  };
  assertReplyDelayCoherent(out);
  return out;
}

/** What these campaigns scheduled on every channel (lead-service, org-scoped; ≤500 ids, its cap). */
export async function fetchScheduledFollowups(orgId: string, campaignIds: string[]): Promise<ScheduledFollowups> {
  if (campaignIds.length > 500) throw new Error(`scheduled-followups: ${campaignIds.length} campaign ids exceed lead-service's 500`);
  const url = process.env.LEAD_SERVICE_URL;
  const key = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !key) throw new Error("LEAD_SERVICE_URL / LEAD_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({ campaignIds: campaignIds.join(",") });
  const res = await fetchWithRetry(`${url}/orgs/followup-dates/scheduled?${params}`, { headers: { "x-api-key": key, "x-org-id": orgId } });
  if (!res.ok) throw new Error(`lead-service /orgs/followup-dates/scheduled failed (${res.status}): ${await res.text()}`);
  return parseScheduledFollowups(await res.json());
}
