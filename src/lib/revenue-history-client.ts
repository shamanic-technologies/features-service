/**
 * Cross-org (fleet-wide) read that feeds the historical `GET /internal/stats/revenue` series — the money
 * twin of active-users-client.ts. Same producer read, same "active = real billed cold-email spend" signal;
 * where active-users keeps only the SET of days a spend happened, revenue keeps the AMOUNT per day.
 *
 * ONE producer read, api-key service-to-service:
 *   - per-org dated cold-email spend → runs-service GET /v1/stats/public/costs/timeseries?interval=day
 *     (api-key only; filters orgId + featureSlugs + startedAfter). Returns dated cost buckets.
 *
 * We take, per org, a Map of UTC day → ACTUALIZED cold-email spend in cents for every day with real
 * billed spend (> 0). Realized (actual) spend is the same billed-money signal the accounts audit gates
 * "active" on, observed after the fact: spend only happens when a brand is NOT paused (paused → held →
 * no send → no spend), HAS a daily budget (spend requires budget authorization), and the org is FUNDED
 * (spend requires affordability). So the sum of actual cold-email spend per day IS the fleet's realized
 * revenue that day. No fabrication: a day with no billed spend simply isn't in the map.
 *
 * MONEY IS NET (post per-org usage discount). runs-service FREEZES each cost row's usage discount at
 * write time, so its cost aggregations expose a `netActualCostInUsdCents` twin next to the gross
 * `actualCostInUsdCents` — the fleet's realized REVENUE (what we actually collect) is the NET sum, so we
 * read the net twin per bucket. The net twin lands on the /costs/timeseries surface IN PARALLEL with this
 * change (runs freezes net on every cost row, 0% for undiscounted orgs). Until that deploy reaches an env,
 * a bucket carries only the gross field — we then fall back to gross with a LOUD one-shot warn (the live
 * staff Revenue view must not break; gross == today's number), and self-activate to net the instant runs
 * ships the twin. A bucket missing BOTH fields fails loud (genuine corruption).
 *
 * Fail loud on any transport / non-OK error (this is the essential input, not optional enrichment).
 */
import { fetchWithRetry } from "./fetch-retry.js";

/** A single dated cost bucket from runs-service /v1/stats/public/costs/timeseries (only the fields we read). */
export interface RunsTimeseriesBucket {
  period?: string;
  actualCostInUsdCents?: string;
  netActualCostInUsdCents?: string;
}

/**
 * Select a bucket's ACTUALIZED spend in cents, PREFERRING the frozen-NET twin (realized revenue = what we
 * collect after the per-org usage discount). Returns `{ cents, net }` — `net` is false when we fell back
 * to the gross field (the runs net-on-timeseries deploy hasn't reached this env yet). Throws when BOTH
 * fields are absent / non-numeric (corruption). Pure — the caller decides whether to warn on a fallback.
 */
export function selectBucketActualCents(bucket: RunsTimeseriesBucket): { cents: number; net: boolean } {
  const net = bucket.netActualCostInUsdCents;
  if (typeof net === "string" && net !== "" && Number.isFinite(Number(net))) return { cents: Number(net), net: true };
  const gross = bucket.actualCostInUsdCents;
  if (typeof gross === "string" && gross !== "" && Number.isFinite(Number(gross))) return { cents: Number(gross), net: false };
  throw new Error(
    `[features-service] runs-service costs/timeseries bucket missing both netActualCostInUsdCents and actualCostInUsdCents: ${JSON.stringify(bucket)}`,
  );
}

function runsConfig(): { url: string; apiKey: string } {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

/**
 * Map of UTC calendar day (YYYY-MM-DD) → NET ACTUALIZED cold-email spend in CENTS for `orgId`, within
 * [startedAfterIso, now]. Reads runs-service dated cost buckets and keeps a day iff its net actual spend
 * is > 0 (real billed spend — the realized-revenue footprint). NET = runs' frozen-discount twin; falls
 * back to gross with a loud warn until the runs net-on-timeseries deploy reaches this env. api-key only.
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

  const data = (await response.json()) as { buckets?: RunsTimeseriesBucket[] };
  if (!Array.isArray(data.buckets)) {
    throw new Error("[features-service] runs-service costs/timeseries returned no buckets array");
  }

  const dailyCents = new Map<string, number>();
  let sawGrossFallback = false;
  for (const b of data.buckets) {
    if (typeof b.period !== "string") {
      throw new Error("[features-service] runs-service costs/timeseries bucket missing period");
    }
    const { cents, net } = selectBucketActualCents(b);
    if (!net) sawGrossFallback = true;
    // Real billed spend on this UTC day ⇒ realized revenue that day. Days with no spend are omitted.
    if (cents > 0) dailyCents.set(b.period.slice(0, 10), (dailyCents.get(b.period.slice(0, 10)) ?? 0) + cents);
  }
  if (sawGrossFallback) {
    // Loud, once per org fetch: runs' net-on-timeseries twin isn't live in this env yet → realized revenue
    // is temporarily GROSS (== today's number). Self-activates to NET the instant runs ships the twin.
    console.warn(
      `[features-service] runs-service costs/timeseries missing netActualCostInUsdCents for org ${orgId} — ` +
        "realized revenue served GROSS until runs ships the net twin (self-activates to net on deploy).",
    );
  }
  return dailyCents;
}
