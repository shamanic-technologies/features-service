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
 * PAST per-UTC-day fleet actuals (cross-org) — BOTH of the two things that happen to an outreach
 * email, on ONE `GET /public/stats?groupBy=day` call.
 *
 * `sentByDay` is EMAIL-grain: `broadcast.emailStats.sent` = COUNT(email_sent events), follow-ups
 * INCLUDED, bucketed by the real SEND timestamp.
 *
 * `createdByDay` is SEQUENCE-grain: `broadcast.recipientStats.contacted` = campaign-created, i.e.
 * the initial touch only — one per lead launched that day.
 *
 * ⚠️ These are TWO DIFFERENT PROCESSES ON TWO DIFFERENT CALENDARS and the forecast must never merge
 * them. Creation is budget-driven and runs SEVEN days a week; sending is throughput-driven and runs
 * Monday-Friday. Measured 2026-09-19: Sat 2026-09-12 created 801 sequences and sent 0; Sun 09-13
 * created 756 and sent 0; the following Monday created 787 and sent 2,489. A chart that shows only
 * the send series draws a weekend as an empty day, hiding a day on which the fleet spent its budget
 * creating 800 sequences. This file used to read only `emailStats.sent` and explicitly discard
 * `recipientStats.contacted` as "the funnel grain" — it is not a grain mismatch, it is the other half
 * of the picture.
 *
 * Scoped to the cold-email outreach feature set so it matches the instantly cold-email fleet the
 * other series describe.
 */
export interface FleetDailyActuals {
  /** Emails SENT that day (email-grain, follow-ups included). */
  sentByDay: Map<string, number>;
  /** Sequences CREATED that day (one per lead launched). */
  createdByDay: Map<string, number>;
}

export async function fetchFleetEmailsSentByDay(featureSlugsCsv: string): Promise<FleetDailyActuals> {
  const { url, apiKey } = emailGatewayConfig();
  const params = new URLSearchParams({ type: "broadcast", groupBy: "day", featureSlugs: featureSlugsCsv, timezone: "UTC" });

  const response = await fetchWithRetry(`${url}/public/stats?${params}`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] email-gateway /public/stats day broadcast failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    groups?: Array<{
      key?: string;
      broadcast?: { emailStats?: { sent?: number }; recipientStats?: { contacted?: number } };
    }>;
  };
  if (!Array.isArray(data.groups)) {
    throw new Error("[features-service] email-gateway /public/stats day broadcast returned no groups array");
  }

  const sentByDay = new Map<string, number>();
  const createdByDay = new Map<string, number>();
  for (const group of data.groups) {
    const sent = group.broadcast?.emailStats?.sent;
    if (typeof group.key !== "string" || typeof sent !== "number" || !Number.isFinite(sent)) {
      throw new Error(`[features-service] email-gateway day group ${group.key} missing numeric emailStats.sent`);
    }
    const created = group.broadcast?.recipientStats?.contacted;
    if (typeof created !== "number" || !Number.isFinite(created)) {
      throw new Error(`[features-service] email-gateway day group ${group.key} missing numeric recipientStats.contacted`);
    }
    // A day with none of a thing is absent rather than zero, so a median over "days it happened"
    // is not dragged down by days it did not. The two series are set INDEPENDENTLY: a weekend has
    // creations and no sends, which is the whole point.
    if (sent > 0) sentByDay.set(group.key, sent);
    if (created > 0) createdByDay.set(group.key, created);
  }
  return { sentByDay, createdByDay };
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
