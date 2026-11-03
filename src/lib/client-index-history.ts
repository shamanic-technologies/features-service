/**
 * THE CLIENT-MEDIAN PUBLIC INDEX (cost per engaged lead), RECOMPUTED FOR PAST DAYS AT REAL VENDOR COST
 * (PUBLIC-VENDOR-COST-1031-HISTORY, owner 2026-10-31 « afficher le cost réel, si on enlève notre markup depuis le début »).
 * PURE; the reads are the run's (`scripts/backfill-fleet-indexes.ts --vendor-clients`).
 *
 * Every other public index was rebuilt from its first day by `fleet-index-history.ts`; this one is a CLIENT figure (a
 * median over clients), so its past needs every client's inputs AS OF each day: per brand, the persons it reached,
 * replied positively, were emailed through our sender and clicked as a judged human, each person cut at the end of the
 * day (`asOfPerson`) then credited (`creditPerson`), the live cell's own rule; spend = the brand's runs at real vendor
 * cost up to that day (the live read's rows: brand, the channel and its sourcing origins, every org), with its unpriced
 * and billed twins. The client ROI index's replay is deleted (ROI-CONSISTENCY-1103).
 */
import { engagedLeadPoint, type BrandEngagement, type FleetIndexPoint } from "./fleet-indexes.js";
import { vendorCoverage } from "./public-vendor-cost.js";
import type { EnginePerson } from "./revenue-engine.js";
import { asOfPerson, creditedSignal, creditPerson, type PersonTimeline } from "./serving-row-credit.js";

const DAY_MS = 86_400_000;
const endOfDayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - 1;
const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** One (campaign, run-start UTC day) of a pair's channel spend on the four bases, cents. */
export interface PairSpendDay {
  campaignId: string | null;
  day: string;
  /** Net billed, committed (what the client paid; printed by the run's population check). */
  netCents: number;
  /** Billed, comped rows included (the engaged lead read's coverage basis). */
  grossIncurredCents: number;
  vendorCents: number;
  /** Billed spend no vendor cost prices. */
  unpricedCents: number;
  /** The population check: each read's own charged gross total of the same rows (vendor read, billed read). */
  checkVendorReadCents: number;
  checkBilledReadCents: number;
}

// ── COST PER ENGAGED LEAD ─────────────────────────────────────────────────────────────────────────

const ENGAGEMENT = ["contacted", "positiveReplies", "screenedContacted", "humanClicks"] as const;
type EngagementMetric = (typeof ENGAGEMENT)[number];

/** Per brand, per-day DIFFERENCE arrays of credited persons (value on day i = Σ diff[0..i]). */
export interface BrandEngagementHistory {
  days: readonly string[];
  /** The day priced on the live inputs untouched (the last of `days` when it is today), else null. */
  todayDay: string | null;
  byBrand: Map<string, Record<EngagementMetric, Float64Array>>;
}

export function emptyBrandEngagementHistory(days: readonly string[], todayDay: string | null): BrandEngagementHistory {
  return { days, todayDay, byBrand: new Map() };
}

function credited(person: EnginePerson, t: PersonTimeline | undefined): Record<EngagementMetric, number> {
  const c = creditPerson(person, t, null);
  return {
    contacted: creditedSignal(c, "contacted") ? 1 : 0,
    positiveReplies: creditedSignal(c, "positiveReply") ? 1 : 0,
    screenedContacted: creditedSignal(c, "screenedContacted") ? 1 : 0,
    humanClicks: creditedSignal(c, "humanClicked") ? 1 : 0,
  };
}

/** The UTC days on which something about the person happened (its credit can only change on those days). */
function eventDays(person: EnginePerson, t: PersonTimeline | undefined): string[] {
  const out = new Set<string>();
  const add = (v: number | string | null | undefined) => {
    const at = typeof v === "number" ? v : msOf(v ?? null);
    if (at !== null) out.add(new Date(at).toISOString().slice(0, 10));
  };
  add(person.servedAt);
  add(person.crmPositiveReplyAt);
  add(person.signalDates?.positiveReply);
  if (t) {
    for (const at of t.firstActBy.values()) add(at);
    for (const e of t.replies) add(e.at);
    for (const e of t.clicks) add(e.at);
    for (const s of t.sends ?? []) {
      add(s.first);
      add(s.last);
    }
  }
  return [...out].sort();
}

/**
 * PURE. Add one (org, brand) pair's deduped persons to the brand's engagement history: between two of a person's event
 * days its credit is constant (computed on the person as of that day's end); today's is the live credit of the person
 * untouched (undated evidence included, as the live cell counts it).
 */
export function addPairBrandEngagement(h: BrandEngagementHistory, brandId: string, persons: readonly EnginePerson[], timelines: ReadonlyMap<string, PersonTimeline>): void {
  const first = h.days[0];
  if (!first) return;
  const n = h.days.length;
  const todayIndex = h.todayDay !== null && h.days[n - 1] === h.todayDay ? n - 1 : n;
  const pastEnd = h.days[todayIndex - 1];
  const indexOf = (day: string) => Math.round((Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`)) / DAY_MS);
  let cells = h.byBrand.get(brandId);
  if (!cells) {
    cells = { contacted: new Float64Array(n + 1), positiveReplies: new Float64Array(n + 1), screenedContacted: new Float64Array(n + 1), humanClicks: new Float64Array(n + 1) };
    h.byBrand.set(brandId, cells);
  }
  const add = (values: Record<EngagementMetric, number>, from: number, until: number) => {
    if (from >= until) return;
    for (const m of ENGAGEMENT) {
      if (!values[m]) continue;
      cells![m][from] += values[m];
      cells![m][until] -= values[m];
    }
  };
  for (const person of persons) {
    const t = timelines.get(person.leadId);
    if (todayIndex < n) add(credited(person, t), todayIndex, n);
    if (!pastEnd) continue;
    if (!person.servedAt && !(t?.sends ?? []).some((x) => x.first !== null)) continue;
    const days = eventDays(person, t)
      .map((d) => (d < first ? first : d))
      .filter((d, i, a) => d <= pastEnd && a.indexOf(d) === i);
    for (let k = 0; k < days.length; k++) {
      const day = days[k]!;
      const until = k + 1 < days.length ? indexOf(days[k + 1]!) : todayIndex;
      const cut = asOfPerson(person, t, endOfDayMs(day));
      if (!cut) continue;
      add(credited(cut.person, cut.timeline), indexOf(day), until);
    }
  }
}

/** PURE. A brand's credited person counts on one day. */
export function brandEngagementOn(h: BrandEngagementHistory, brandId: string, dayIndex: number): Record<EngagementMetric, number> {
  const out = { contacted: 0, positiveReplies: 0, screenedContacted: 0, humanClicks: 0 };
  const c = h.byBrand.get(brandId);
  if (!c) return out;
  for (const m of ENGAGEMENT) {
    let s = 0;
    for (let i = 0; i <= dayIndex; i++) s += c[m][i]!;
    out[m] = Math.round(s);
  }
  return out;
}

/** PURE. The engaged lead index point of one day: each brand's counts, its vendor spend by then and whether it is known. */
export function engagedLeadPointOn(
  h: BrandEngagementHistory,
  spendByBrand: ReadonlyMap<string, readonly PairSpendDay[]>,
  dayIndex: number,
): { point: FleetIndexPoint; brands: Array<BrandEngagement & { brandId: string }> } {
  const day = h.days[dayIndex]!;
  const brandIds = new Set([...h.byBrand.keys(), ...spendByBrand.keys()]);
  const brands = [...brandIds].sort().map((brandId) => {
    let vendor = 0;
    let unpriced = 0;
    let gross = 0;
    for (const s of spendByBrand.get(brandId) ?? []) {
      if (s.day > day) continue;
      vendor += s.vendorCents;
      unpriced += s.unpricedCents;
      gross += s.grossIncurredCents;
    }
    const cov = vendorCoverage(vendor / 100, unpriced / 100, gross / 100);
    return { brandId, ...brandEngagementOn(h, brandId, dayIndex), spendCents: vendor, vendorCostUnknown: !cov.servable };
  });
  return { point: engagedLeadPoint(brands), brands };
}
