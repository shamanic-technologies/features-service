/**
 * Platform-global email funnel conversion rates, from email-gateway GET /public/stats.
 *
 * No filter → aggregate across ALL orgs / workflows (Kevin: "stats au niveau global de la
 * plateforme, ça dépend pas d'un client, pas d'un workflow"). We sum the transactional +
 * broadcast recipient funnel counts and derive the stage-to-stage probabilities used to
 * give a lead expected revenue from its FURTHEST reached status (Contacted onward), not
 * only from a click / positive reply.
 *
 * The aggregate is heavy (cross-org) and the same for every caller, so it is cached
 * in-memory for a short TTL. Fail-loud on a cold-miss fetch error — these rates are a
 * core input to the pipeline total.
 *
 * V2 (DIS-N follow-up): per-workflow rates for delivered→click / delivered→positiveReply
 * via /public/stats?groupBy=workflowSlug, keyed per lead by workflowSlug.
 */

import { fetchWithRetry } from "./fetch-retry.js";

export interface PlatformEmailRates {
  /** P(sent | contacted) */
  sentPerContacted: number;
  /** P(delivered | sent) */
  deliveredPerSent: number;
  /** P(clicked | delivered) */
  clickedPerDelivered: number;
  /** P(positive reply | delivered) */
  positiveReplyPerDelivered: number;
}

interface RecipientStats {
  contacted?: number;
  sent?: number;
  delivered?: number;
  clicked?: number;
  repliesPositive?: number;
}

interface ProviderStats {
  recipientStats?: RecipientStats;
}

interface PublicStatsResponse {
  transactional?: ProviderStats;
  broadcast?: ProviderStats;
}

// 5s = the dashboard poll cadence. The module-level cache is shared across ALL callers, so
// this is one email-gateway fetch per 5s for the whole service (NOT per viewer / per campaign
// in a groupBy loop). Matching the poll interval keeps the revenue number in sync with the
// per-request-fresh cost/leads metrics — a longer TTL made revenue jump on a coarser cadence
// than everything else on the dashboard.
const TTL_MS = 5_000;
let cache: { rates: PlatformEmailRates; expiresAt: number } | null = null;

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

function sumFunnel(data: PublicStatsResponse): Required<RecipientStats> {
  const acc = { contacted: 0, sent: 0, delivered: 0, clicked: 0, repliesPositive: 0 };
  for (const provider of [data.transactional, data.broadcast]) {
    const r = provider?.recipientStats;
    if (!r) continue;
    acc.contacted += r.contacted ?? 0;
    acc.sent += r.sent ?? 0;
    acc.delivered += r.delivered ?? 0;
    acc.clicked += r.clicked ?? 0;
    acc.repliesPositive += r.repliesPositive ?? 0;
  }
  return acc;
}

export async function fetchPlatformEmailRates(): Promise<PlatformEmailRates> {
  if (cache && cache.expiresAt > Date.now()) return cache.rates;

  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const response = await fetchWithRetry(`${url}/public/stats`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /public/stats failed (${response.status}): ${text}`);
  }

  const f = sumFunnel((await response.json()) as PublicStatsResponse);
  const rates: PlatformEmailRates = {
    sentPerContacted: ratio(f.sent, f.contacted),
    deliveredPerSent: ratio(f.delivered, f.sent),
    clickedPerDelivered: ratio(f.clicked, f.delivered),
    positiveReplyPerDelivered: ratio(f.repliesPositive, f.delivered),
  };

  cache = { rates, expiresAt: Date.now() + TTL_MS };
  return rates;
}

/** Test seam — reset the in-memory cache. */
export function __resetPlatformRatesCache(): void {
  cache = null;
}
