/**
 * Cross-org (fleet-wide) reads that feed the global `GET /internal/stats/send-forecast` endpoint.
 * Both go through email-gateway (the provider-agnostic outreach layer) so the forecast stays correct
 * if another outreach provider is added beside instantly. api-key only, no org identity.
 *
 * Fail loud on any transport / non-OK error (these are essential inputs, not optional enrichment).
 */
import { fetchWithRetry } from "./fetch-retry.js";

function emailGatewayConfig(): { url: string; apiKey: string } {
  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

/**
 * Series 1 — PAST real emails sent per UTC day, fleet-wide (cross-org), EMAIL-GRAIN.
 *
 * Reads email-gateway `GET /public/stats?groupBy=day` and takes `broadcast.emailStats.sent` per day
 * group — that is `COUNT(email_sent events)` (follow-ups INCLUDED), bucketed by real send timestamp.
 * NOT `recipientStats.contacted` (which is campaign-created = initials only, the funnel grain) — the
 * forecast stacks email-grain series, so the past actual must be email-grain too.
 *
 * Scoped to the cold-email outreach feature set so it matches the instantly cold-email fleet the
 * other two series describe.
 */
export async function fetchFleetEmailsSentByDay(featureSlugsCsv: string): Promise<Map<string, number>> {
  const { url, apiKey } = emailGatewayConfig();
  const params = new URLSearchParams({ type: "broadcast", groupBy: "day", featureSlugs: featureSlugsCsv, timezone: "UTC" });

  const response = await fetchWithRetry(`${url}/public/stats?${params}`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats day broadcast failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    groups?: Array<{ key?: string; broadcast?: { emailStats?: { sent?: number } } }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("[features-service] email-gateway /public/stats day broadcast returned no groups array");
  }

  const byDay = new Map<string, number>();
  for (const group of data.groups) {
    const sent = group.broadcast?.emailStats?.sent;
    if (typeof group.key !== "string" || typeof sent !== "number" || !Number.isFinite(sent)) {
      throw new Error(`[features-service] email-gateway day group ${group.key} missing numeric emailStats.sent`);
    }
    if (sent > 0) byDay.set(group.key, sent);
  }
  return byDay;
}

/**
 * Series 2 — FUTURE already-scheduled follow-up sends per UTC day (in-flight cohorts started before
 * today), fleet-wide. Relayed by email-gateway `GET /public/stats/sending-forecast`, which proxies
 * instantly `/internal/audit/sending-forecast` (provisioned sequence steps projected forward).
 */
export async function fetchFleetSendingForecast(): Promise<Map<string, number>> {
  const { url, apiKey } = emailGatewayConfig();

  const response = await fetchWithRetry(`${url}/public/stats/sending-forecast`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats/sending-forecast failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    days?: Array<{ date?: string; scheduledCount?: number }>;
  };
  if (!Array.isArray(data.days)) {
    throw new Error("[features-service] email-gateway /public/stats/sending-forecast returned no days array");
  }

  const byDay = new Map<string, number>();
  for (const day of data.days) {
    if (typeof day.date !== "string" || typeof day.scheduledCount !== "number" || !Number.isFinite(day.scheduledCount)) {
      throw new Error(`[features-service] sending-forecast day ${day.date} missing numeric scheduledCount`);
    }
    byDay.set(day.date, day.scheduledCount);
  }
  return byDay;
}
