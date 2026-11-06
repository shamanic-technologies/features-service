/**
 * The Units one campaign's runs PRODUCED, per outcome and UTC day, from runs-service's ledger (`GET
 * /internal/stats/outcome-costs?groupBy=outcomeKey,day&campaignId=`, its own inception to today). Any outcome, posts
 * included. Held 60 s per campaign. FAIL-LOUD: the caller decides to degrade.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface CampaignLedgerUnits {
  /** outcome key -> UTC day -> produced occurrences. */
  byOutcome: Map<string, Map<string, number>>;
  /** Ledger days runs-service has not computed yet (or computed before a later fact): counts there may still move. */
  daysMissing: string[];
}

const HELD_MS = 60_000;
const held = new Map<string, { at: number; value: Promise<CampaignLedgerUnits> }>();

interface Wire {
  daysMissing?: string[];
  produced?: Array<{ dimensions?: Record<string, string | null>; occurrences?: number }>;
}

/** PURE. The wire body as per-outcome per-day counts. */
export function parseCampaignLedgerUnits(body: Wire): CampaignLedgerUnits {
  const byOutcome = new Map<string, Map<string, number>>();
  for (const g of body.produced ?? []) {
    const key = g.dimensions?.outcomeKey;
    const day = g.dimensions?.day;
    if (!key || !day) throw new Error("[features-service] campaign ledger units: a produced group names no outcomeKey or day");
    const days = byOutcome.get(key) ?? byOutcome.set(key, new Map()).get(key)!;
    days.set(day, (days.get(day) ?? 0) + (g.occurrences ?? 0));
  }
  return { byOutcome, daysMissing: [...(body.daysMissing ?? [])].sort() };
}

export function fetchCampaignLedgerUnits(campaignId: string): Promise<CampaignLedgerUnits> {
  const h = held.get(campaignId);
  if (h && Date.now() - h.at < HELD_MS) return h.value;
  const value = (async () => {
    const r = await fetchWithRetry(`${process.env.RUNS_SERVICE_URL}/internal/stats/outcome-costs?groupBy=outcomeKey,day&campaignId=${encodeURIComponent(campaignId)}`, {
      headers: { "x-api-key": process.env.RUNS_SERVICE_API_KEY ?? "" },
    });
    if (!r.ok) throw new Error(`[features-service] runs-service outcome-costs for campaign ${campaignId} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return parseCampaignLedgerUnits((await r.json()) as Wire);
  })();
  value.catch(() => held.delete(campaignId));
  held.set(campaignId, { at: Date.now(), value });
  return value;
}

/** PURE. Several campaigns' units summed per outcome and day. */
export function sumLedgerUnits(parts: readonly CampaignLedgerUnits[]): CampaignLedgerUnits {
  const byOutcome = new Map<string, Map<string, number>>();
  for (const p of parts)
    for (const [k, days] of p.byOutcome) {
      const into = byOutcome.get(k) ?? byOutcome.set(k, new Map()).get(k)!;
      for (const [d, n] of days) into.set(d, (into.get(d) ?? 0) + n);
    }
  return { byOutcome, daysMissing: [...new Set(parts.flatMap((p) => p.daysMissing))].sort() };
}
