/**
 * THE TWO CLIENT-MEDIAN PUBLIC INDEXES, RECOMPUTED FOR PAST DAYS AT REAL VENDOR COST (PUBLIC-VENDOR-COST-1031-HISTORY,
 * owner 2026-10-31 « afficher le cost réel, si on enlève notre markup depuis le début »). PURE; the reads are the run's
 * (`scripts/backfill-fleet-indexes.ts --vendor-clients`).
 *
 * Every other public index was rebuilt from its first day by `fleet-index-history.ts`; these two are CLIENT figures (a
 * median over clients), so their past needs every client's inputs AS OF each day:
 *   - COST PER ENGAGED LEAD (`engagedLeadPoint`): per brand, the persons it reached, replied positively, were emailed
 *     through our sender and clicked as a judged human, each person cut at the end of the day (`asOfPerson`) then
 *     credited (`creditPerson`), the live cell's own rule; spend = the brand's runs at real vendor cost up to that day
 *     (the live read's rows: brand, the channel and its sourcing origins, every org), with its unpriced and billed twins.
 *   - ROI (`clientReturnPoint` over `vendorReturnMedian`): each (org, brand) engine pass, captured once on today's live
 *     inputs (`lib/engine-capture.ts`: persons, paths, pricing), replayed as of the day: the persons cut at the end of
 *     the day (`engineAsOf`), the mature cohort cut at that day's cutoff, the contacted value's expiry read from that day;
 *     the mature spend = runs started before that cutoff (+ the campaigns that wait for nothing), on the net billed basis
 *     (the $100 floor) and at vendor cost (the divisor); the brand's verdict as of the day (`buildScopeMaturity`).
 * Today's rules (pricing terms, ladders, statements, disqualification marks) stand on every day, like the other indexes'
 * history. Evidence with no date is in no past day; the replay of TODAY prices the live inputs untouched, so it is the
 * live figure by construction (the run prints both).
 */
import { clientReturnPoint, engagedLeadPoint, type BrandEngagement, type FleetIndexPoint } from "./fleet-indexes.js";
import type { EngineCapture } from "./engine-capture.js";
import { vendorReturnMedian } from "./fleet-return-vendor.js";
import type { BrandReturnRow } from "./fleet-return-on-spend.js";
import { combineVerdicts } from "./fleet-return-maturity.js";
import { legCutoffIso, maturityCutoffIso } from "./maturity.js";
import { serveDatesStated } from "./mature-evidence.js";
import { vendorCoverage } from "./public-vendor-cost.js";
import { computeRevenue, contactedExpiryCutoffIso, type EnginePerson } from "./revenue-engine.js";
import { matureCohortPersons } from "./roi-maturity.js";
import { buildScopeMaturity, campaignKey, type SpendSplit } from "./scope-maturity.js";
import { asOfPerson, creditedSignal, creditPerson, type PersonTimeline } from "./serving-row-credit.js";

const DAY_MS = 86_400_000;
const endOfDayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - 1;
const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The engine signals the engine dates (`signalDates`): each stands from its own date; undated = in no past day. */
const DATED_SIGNALS: ReadonlySet<string> = new Set([
  "contacted",
  "open",
  "clicked",
  "positiveReply",
  "meeting",
  "meetingAttended",
  "closeWin",
  "signup",
  "formSubmission",
]);

/**
 * PURE. An engine person as of `endMs`: in scope from its entry (serve, else first send) on; each dated signal from its
 * date, an undated one in no past day; a flag the engine never dates (bounced, unsubscribed, delivered) stands from the
 * entry. A last send after the day stands on the first send (the last one by then is not on the row). Null = not in
 * scope yet, or never dated.
 */
export function engineAsOf(person: EnginePerson, endMs: number): EnginePerson | null {
  const served = msOf(person.servedAt ?? null);
  const firstSend = msOf(person.signalDates?.contacted ?? null);
  const entries = [served, firstSend].filter((t): t is number => t !== null);
  if (entries.length === 0) return null;
  const entry = Math.min(...entries);
  if (entry > endMs) return null;
  const servedAt = served !== null && served <= endMs ? person.servedAt! : new Date(entry).toISOString();
  const signals: Record<string, boolean> = {};
  const signalDates: Record<string, string | null> = { ...(person.signalDates ?? {}) };
  for (const [key, on] of Object.entries(person.signals)) {
    if (!on) {
      signals[key] = false;
      continue;
    }
    if (!DATED_SIGNALS.has(key)) {
      signals[key] = true;
      continue;
    }
    const at = msOf(person.signalDates?.[key] ?? null);
    signals[key] = at !== null && at <= endMs;
    if (!signals[key]) signalDates[key] = null;
  }
  const lastSent = msOf(person.signalDates?.lastSent ?? null);
  if (lastSent !== null && lastSent > endMs) signalDates.lastSent = firstSend !== null && firstSend <= endMs ? person.signalDates!.contacted! : null;
  const crm = msOf(person.crmPositiveReplyAt ?? null);
  return {
    ...person,
    servedAt,
    signals,
    signalDates,
    crmPositiveReplyAt: crm !== null && crm <= endMs ? (person.crmPositiveReplyAt ?? null) : null,
  };
}

/** One (campaign, run-start UTC day) of a pair's channel spend on the four bases, cents. */
export interface PairSpendDay {
  campaignId: string | null;
  day: string;
  /** Net billed, committed (the ROI floor's basis: what the client paid). */
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

/** One (org, brand) pass as of one day: the ingredients one brand row of the return median composes. */
export interface PairReturnDay {
  maturePipelineUsd: number | null;
  matureNetUsd: number;
  matureVendorUsd: number;
  matureUnpricedUsd: number;
  isMature: boolean | null;
}

/**
 * PURE. A pair's ROI ingredients on each of `days` (the last may be today: `todayDay`, priced on the captured inputs
 * untouched). `capture` null = the live pass priced nothing (no economics): no pipeline, no verdict.
 */
export function replayPairReturn(capture: EngineCapture | null, spend: readonly PairSpendDay[], days: readonly string[], todayDay: string): PairReturnDay[] {
  const legOf = new Map((capture?.campaigns ?? []).map((c) => [c.id, c.legKey] as const));
  return days.map((day) => {
    const endMs = endOfDayMs(day);
    const isToday = day === todayDay;
    const now = isToday ? null : new Date(`${day}T12:00:00.000Z`);
    const plan = capture && !isToday && capture.plan.cutoffIso ? { ...capture.plan, cutoffIso: maturityCutoffIso(capture.plan.days, now!) } : capture?.plan;
    const matureCut = Boolean(capture?.matureCut && plan?.cutoffIso);
    const cutoffDay = matureCut ? plan!.cutoffIso!.slice(0, 10) : null;
    let net = 0;
    let vendor = 0;
    let unpriced = 0;
    for (const s of spend) {
      if (s.day > day) continue;
      const waits = cutoffDay !== null && s.campaignId !== null && plan!.delayedCampaignIds.has(s.campaignId);
      if (cutoffDay !== null && s.day >= cutoffDay && waits) continue;
      net += s.netCents;
      vendor += s.vendorCents;
      unpriced += s.unpricedCents;
    }
    const base = { matureNetUsd: net / 100, matureVendorUsd: vendor / 100, matureUnpricedUsd: unpriced / 100 };
    if (!capture) return { ...base, maturePipelineUsd: null, isMature: null };
    const persons = isToday ? capture.persons : capture.persons.map((p) => engineAsOf(p, endMs)).filter((p): p is EnginePerson => p !== null);
    const contacted = capture.contacted && !isToday ? { ...capture.contacted, lastSentOnOrAfter: contactedExpiryCutoffIso(new Date(endMs)) } : capture.contacted;
    const maturePersons = matureCut ? matureCohortPersons(persons, plan!) : persons;
    const maturePipelineUsd = computeRevenue(capture.paths, maturePersons, capture.closeValueUsd, capture.milestones, contacted).headline.totalPipelineUsd;
    // The verdict as of the day: the scope's legs on the persons and the net spend split by then (`fetchSpendSplit`'s
    // per-leg cut, read at that day's clock).
    let isMature: boolean | null = null;
    if (capture.campaigns !== null && !capture.plan.unknown) {
      const split = new Map<string, { flash: number; mature: number }>();
      for (const s of spend) {
        if (s.day > day) continue;
        const key = campaignKey(s.campaignId);
        const cutoff = legCutoffIso(s.campaignId ? legOf.get(s.campaignId) : null, now ?? new Date());
        const entry = split.get(key) ?? { flash: 0, mature: 0 };
        entry.flash += s.netCents;
        if (!cutoff || s.day < cutoff.slice(0, 10)) entry.mature += s.netCents;
        split.set(key, entry);
      }
      const spendSplit = new Map<string, SpendSplit>([...split].map(([k, v]) => [k, { flash: v.flash.toFixed(10), mature: v.mature.toFixed(10) }]));
      isMature = buildScopeMaturity({
        campaigns: capture.campaigns,
        persons,
        spend: spendSplit,
        serveDatesStated: serveDatesStated(persons),
        ...(now ? { now } : {}),
      }).isMature;
    }
    return { ...base, maturePipelineUsd, isMature };
  });
}

/** One brand's pairs, day by day, composed as the fleet-return warm composes them (pipelines and spend summed). */
export function brandReturnRowsOn(pairs: ReadonlyArray<{ brandId: string; days: readonly PairReturnDay[] }>, dayIndex: number): BrandReturnRow[] {
  const byBrand = new Map<string, { pipeline: number; hasPipeline: boolean; net: number; vendor: number; unpriced: number; verdicts: Array<boolean | null> }>();
  for (const p of pairs) {
    const d = p.days[dayIndex];
    if (!d) continue;
    const agg = byBrand.get(p.brandId) ?? { pipeline: 0, hasPipeline: false, net: 0, vendor: 0, unpriced: 0, verdicts: [] };
    if (d.maturePipelineUsd !== null) {
      agg.pipeline += d.maturePipelineUsd;
      agg.hasPipeline = true;
    }
    agg.net += d.matureNetUsd;
    agg.vendor += d.matureVendorUsd;
    agg.unpriced += d.matureUnpricedUsd;
    agg.verdicts.push(d.isMature);
    byBrand.set(p.brandId, agg);
  }
  return [...byBrand].map(([brandId, a]) => ({
    brandId,
    committedSpendUsd: a.net,
    expectedPipelineUsd: a.hasPipeline ? a.pipeline : null,
    isMature: combineVerdicts(a.verdicts) ?? null,
    vendorSpend: { flashUsd: a.vendor, matureUsd: a.vendor, unpricedFlashUsd: a.unpriced, unpricedMatureUsd: a.unpriced },
  }));
}

/** The owner's ROI bar (« la médiane des clients ayant dépensé au moins $100 »), the live index's. */
export const CLIENT_RETURN_MIN_SPEND_USD = 100;

/** PURE. The ROI index point of one day from its brand rows (the live `readFleetVendorReturn` rule). */
export function roiPointOn(rows: readonly BrandReturnRow[]): FleetIndexPoint {
  const r = vendorReturnMedian(rows, CLIENT_RETURN_MIN_SPEND_USD);
  return clientReturnPoint({ ...r, minSpendUsd: CLIENT_RETURN_MIN_SPEND_USD });
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
