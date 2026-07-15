/**
 * Cross-org (fleet-wide) read that feeds the historical `GET /internal/stats/revenue` series — the money
 * twin of active-users-client.ts. Same producer read, same "active = real billed cold-email spend" signal;
 * where active-users keeps only the SET of days a spend happened, revenue keeps the AMOUNT per day.
 *
 * ONE producer read, api-key service-to-service:
 *   - per-org dated cold-email spend → runs-service GET /v1/stats/public/costs/timeseries?interval=day
 *     (api-key only; filters orgId + featureSlugs + startedAfter). Returns dated cost buckets.
 *
 * We take, per org, a Map of UTC day → ACTUALIZED cold-email spend in cents (actualCostInUsdCents) for
 * every day with real billed spend (> 0). Realized (actual) spend is the same billed-money signal the
 * accounts audit gates "active" on, observed after the fact: spend only happens when a brand is NOT paused
 * (paused → held → no send → no spend), HAS a daily budget (spend requires budget authorization), and the
 * org is FUNDED (spend requires affordability). So the sum of actual cold-email spend per day IS the
 * fleet's realized revenue that day. No fabrication: a day with no billed spend simply isn't in the map.
 *
 * Fail loud on any transport / non-OK error (this is the essential input, not optional enrichment).
 */
import { fetchWithRetry } from "./fetch-retry.js";

function runsConfig(): { url: string; apiKey: string } {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

/**
 * Map of UTC calendar day (YYYY-MM-DD) → ACTUALIZED cold-email spend in CENTS for `orgId`, within
 * [startedAfterIso, now]. Reads runs-service dated cost buckets and keeps a day iff its
 * `actualCostInUsdCents` is > 0 (real billed spend — the realized-revenue footprint). api-key only.
 */
export async function fetchOrgDailySpendCents(
  orgId: string,
  coldEmailSlugsCsv: string,
  startedAfterIso: string,
): Promise<Map<string, number>> {
  const { url, apiKey } = runsConfig();
  const params = new URLSearchParams({
    interval: "day",
    featureSlugs: coldEmailSlugsCsv,
    orgId,
    startedAfter: startedAfterIso,
    tz: "UTC",
  });

  const response = await fetchWithRetry(`${url}/v1/stats/public/costs/timeseries?${params}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] runs-service costs/timeseries (revenue) failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    buckets?: Array<{ period?: string; actualCostInUsdCents?: string }>;
  };
  if (!Array.isArray(data.buckets)) {
    throw new Error("[features-service] runs-service costs/timeseries returned no buckets array");
  }

  const dailyCents = new Map<string, number>();
  for (const b of data.buckets) {
    if (typeof b.period !== "string" || typeof b.actualCostInUsdCents !== "string") {
      throw new Error("[features-service] runs-service costs/timeseries bucket missing period/actualCostInUsdCents");
    }
    const cents = Number(b.actualCostInUsdCents);
    // Real billed spend on this UTC day ⇒ realized revenue that day. Days with no spend are omitted.
    if (cents > 0) dailyCents.set(b.period.slice(0, 10), (dailyCents.get(b.period.slice(0, 10)) ?? 0) + cents);
  }
  return dailyCents;
}
