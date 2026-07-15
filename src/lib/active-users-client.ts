/**
 * Cross-org (fleet-wide) read that feeds the historical `GET /internal/stats/active-users` series.
 *
 * ONE producer read, api-key service-to-service:
 *   - per-org dated cold-email spend → runs-service GET /v1/stats/public/costs/timeseries?interval=day
 *     (api-key only; filters orgId + featureSlugs + startedAfter). Returns dated cost buckets.
 *
 * We take the set of UTC days on which the org has ACTUALIZED cold-email spend (actualCostInUsdCents > 0).
 * A day of real billed cold-email spend is the faithful HISTORICAL reconstruction of "this org had an
 * active, funded, non-paused brand that day": spend only happens when a brand is NOT paused (paused
 * campaigns are held → no send → no spend), HAS a daily budget (spend requires budget authorization),
 * and the org is FUNDED (spend requires affordability authorization). So distinct-orgs-with-actual-
 * cold-email-spend-on-day-D == the accounts active-verdict, observed after the fact. No fabrication:
 * a day with no billed spend simply isn't in the set.
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
 * The set of UTC calendar days (YYYY-MM-DD) on which `orgId` produced ACTUALIZED cold-email spend,
 * within [startedAfterIso, now]. Reads runs-service dated cost buckets and keeps a day iff its
 * `actualCostInUsdCents` is > 0 (real billed spend — the active-verdict footprint). api-key only.
 */
export async function fetchOrgActiveDays(
  orgId: string,
  coldEmailSlugsCsv: string,
  startedAfterIso: string,
): Promise<Set<string>> {
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
    throw new Error(`[features-service] runs-service costs/timeseries (active-users) failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    buckets?: Array<{ period?: string; actualCostInUsdCents?: string }>;
  };
  if (!Array.isArray(data.buckets)) {
    throw new Error("[features-service] runs-service costs/timeseries returned no buckets array");
  }

  const activeDays = new Set<string>();
  for (const b of data.buckets) {
    if (typeof b.period !== "string" || typeof b.actualCostInUsdCents !== "string") {
      throw new Error("[features-service] runs-service costs/timeseries bucket missing period/actualCostInUsdCents");
    }
    // Real billed spend on this UTC day ⇒ the org was active/funded/non-paused that day.
    if (Number(b.actualCostInUsdCents) > 0) activeDays.add(b.period.slice(0, 10));
  }
  return activeDays;
}
