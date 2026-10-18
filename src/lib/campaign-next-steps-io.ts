/**
 * IO half of `campaign-next-steps.ts` (CAMPAIGN-NEXT-STEPS-1018): instantly-service's send queue (org-scoped) and its
 * first-email -> first-positive-reply latency (cross-org aggregate, grouped by campaign ids). Both FAIL LOUD (throw);
 * the route turns a failure into a named null, never a zero.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { parseEmailSendQueue, type EmailSendQueue, type LatencyMetric } from "./campaign-next-steps.js";

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
  if (!m || typeof m.sampleSize !== "number") throw new Error("engagement-latency: metric missing sampleSize");
  const n = (v: unknown): number | null => (v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : (() => { throw new Error("engagement-latency: metric value is not a number"); })());
  return { averageMs: n(m.averageMs), medianMs: n(m.medianMs), sampleSize: m.sampleSize };
}

/** First email -> first positive reply, per group of campaign ids, since inception. Groups with no id are skipped. */
export async function fetchReplyLatencyByCampaignGroups(groups: Record<string, string[]>): Promise<Record<string, LatencyMetric>> {
  const body: Record<string, { campaignIds: string[] }> = {};
  for (const [k, ids] of Object.entries(groups)) if (ids.length > 0) body[k] = { campaignIds: ids };
  if (Object.keys(body).length === 0) return {};
  const { url, key } = instantlyBase();
  const res = await fetchWithRetry(`${url}/public/stats/engagement-latency/grouped`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ groups: body }),
  });
  if (!res.ok) throw new Error(`instantly-service /public/stats/engagement-latency/grouped failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { groups?: unknown };
  if (!Array.isArray(data.groups)) throw new Error("instantly-service engagement-latency/grouped returned no groups array");
  const out: Record<string, LatencyMetric> = {};
  for (const g of data.groups as Record<string, unknown>[]) out[String(g.key)] = readMetric(g.timeToFirstPositiveReply);
  return out;
}
