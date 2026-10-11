import { fetchWithRetry } from "./fetch-retry.js";

/**
 * twillio-service's call counts per campaign since inception (`GET /calls/stats/by-campaign?campaignIds=`, v0.16.5,
 * org-scoped by `x-org-id`, `x-user-id` required). Relayed in twillio-service's own vocabulary: `requested` (every
 * call row) ⊇ `placed` (Twilio dialled it) ⊇ `accepted` (the rep pressed 1) ⊇ `connected` (bridged to the prospect:
 * the booking call obtained); `outcomes` partitions `requested`; billed minutes per leg. `daily` = one entry per UTC
 * day with a call (the day the call was requested), adding up to `totals`. A campaign with no call answers zeros.
 */
export interface CallCounts {
  requested: number;
  placed: number;
  accepted: number;
  connected: number;
  outcomes: Record<string, number>;
  billedMinutes: number;
  connectBilledMinutes: number;
  totalBilledMinutes: number;
}

export interface CampaignCalls {
  totals: CallCounts;
  daily: Array<CallCounts & { day: string }>;
}

const MAX_CAMPAIGN_IDS = 200;

function assertCounts(c: unknown): asserts c is CallCounts {
  const o = c as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !["requested", "placed", "accepted", "connected"].every((k) => typeof o[k] === "number") || !o.outcomes || typeof o.outcomes !== "object") {
    throw new Error("twillio-service /calls/stats/by-campaign returned malformed counts");
  }
}

export async function fetchCampaignCalls(
  campaignIds: readonly string[],
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<Map<string, CampaignCalls>> {
  const url = process.env.TWILIO_SERVICE_URL;
  const apiKey = process.env.TWILIO_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("TWILIO_SERVICE_URL or TWILIO_SERVICE_API_KEY not configured");
  if (!headers.userId) throw new Error("twillio-service requires x-user-id");
  const ids = [...new Set(campaignIds)];
  const out = new Map<string, CampaignCalls>();
  for (let i = 0; i < ids.length; i += MAX_CAMPAIGN_IDS) {
    const chunk = ids.slice(i, i + MAX_CAMPAIGN_IDS);
    const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-user-id": headers.userId, "x-service-name": "features-service" };
    if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
    const response = await fetchWithRetry(`${url}/calls/stats/by-campaign?campaignIds=${chunk.map(encodeURIComponent).join(",")}`, { headers: reqHeaders });
    if (!response.ok) throw new Error(`twillio-service /calls/stats/by-campaign failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { campaigns?: unknown };
    if (!Array.isArray(data.campaigns)) throw new Error("twillio-service /calls/stats/by-campaign returned no campaigns array");
    for (const raw of data.campaigns as Array<Record<string, unknown>>) {
      if (typeof raw.campaignId !== "string" || !Array.isArray(raw.daily)) throw new Error("twillio-service /calls/stats/by-campaign returned a malformed campaign");
      assertCounts(raw.totals);
      for (const d of raw.daily) assertCounts(d);
      out.set(raw.campaignId, { totals: raw.totals, daily: raw.daily as CampaignCalls["daily"] });
    }
  }
  return out;
}
