/**
 * The Units one campaign's runs PRODUCED, per outcome and UTC day, from runs-service's ledger (`GET
 * /internal/stats/outcome-costs?groupBy=outcomeKey,day&campaignId=`, its own inception to today). Any outcome, posts
 * included. Held 60 s per campaign. FAIL-LOUD: the caller decides to degrade.
 */
import { campaignLedgerByDayPath, readRunsLedger } from "./runs-ledger-read.js";

export interface CampaignLedgerUnits {
  /** outcome key -> UTC day -> produced occurrences. */
  byOutcome: Map<string, Map<string, number>>;
  /** Ledger days runs-service has not computed yet (or computed before a later fact): counts there may still move. */
  daysMissing: string[];
}

const HELD_MS = 60_000;

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

const parses = new WeakMap<object, CampaignLedgerUnits>();

/**
 * LEDGER-LOAD-1107: the SAME runs-service read as the campaign's scope ledger (`campaignLedgerByDayPath`), shared
 * process-wide and held 60 s from its arrival, parsed once per body.
 */
export async function fetchCampaignLedgerUnits(campaignId: string): Promise<CampaignLedgerUnits> {
  const a = await readRunsLedger(campaignLedgerByDayPath(campaignId), HELD_MS);
  if (!a.ok) throw new Error(`[features-service] runs-service outcome-costs for campaign ${campaignId} ${a.status}: ${a.text.slice(0, 200)}`);
  const w = a.json as object;
  const prior = parses.get(w);
  if (prior) return prior;
  const parsed = parseCampaignLedgerUnits(a.json as Wire);
  parses.set(w, parsed);
  return parsed;
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
