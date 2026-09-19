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
 * Series 2 + the fleet's send CAPACITY. Relayed by email-gateway `GET /public/stats/sending-forecast`,
 * which proxies the broadcast provider's own forecast.
 *
 * Two things come back on ONE payload and the forecast needs BOTH:
 *   - `dailyCapacity` — emails/day the healthy fleet can physically send. The ceiling every projected
 *     day is drained under. It was on this response all along and was being discarded.
 *   - `days[].scheduledCount` — provisioned follow-up steps for in-flight (pre-today) cohorts, dated
 *     by when the provider considers them DUE. When they actually go out is this service's answer,
 *     not the provider's: a step due on a Saturday, or one due on a day already at capacity, sends
 *     later. See send-forecast-compute.ts.
 *
 * Both fields are required on the producer's contract; a missing or non-numeric one is a read we did
 * not get, never a zero.
 */
export interface FleetSendingForecast {
  /** Emails/day the healthy fleet can physically send. */
  dailyCapacity: number;
  /** Provisioned in-flight follow-ups becoming DUE per UTC day. */
  scheduledByDay: Map<string, number>;
}

export async function fetchFleetSendingForecast(): Promise<FleetSendingForecast> {
  const { url, apiKey } = emailGatewayConfig();

  const response = await fetchWithRetry(`${url}/public/stats/sending-forecast`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats/sending-forecast failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    dailyCapacity?: number;
    days?: Array<{ date?: string; scheduledCount?: number }>;
  };
  if (!Array.isArray(data.days)) {
    throw new Error("[features-service] email-gateway /public/stats/sending-forecast returned no days array");
  }
  if (typeof data.dailyCapacity !== "number" || !Number.isFinite(data.dailyCapacity)) {
    throw new Error("[features-service] email-gateway /public/stats/sending-forecast returned no numeric dailyCapacity");
  }

  const scheduledByDay = new Map<string, number>();
  for (const day of data.days) {
    if (typeof day.date !== "string" || typeof day.scheduledCount !== "number" || !Number.isFinite(day.scheduledCount)) {
      throw new Error(`[features-service] sending-forecast day ${day.date} missing numeric scheduledCount`);
    }
    scheduledByDay.set(day.date, day.scheduledCount);
  }
  return { dailyCapacity: data.dailyCapacity, scheduledByDay };
}
