/**
 * THE PUBLIC FLEET INDEXES, RECOMPUTED FOR PAST DAYS (owner 2026-10-19, INDEX-HISTORY-BACKFILL-1019). Pure; the reads are
 * `fleet-index-history-io.ts`, the one-shot run `scripts/backfill-fleet-indexes.ts`.
 *
 * The live recorder (`routes/fleet-indexes.ts`) writes one point per index per day since 2026-10-18. Every earlier UTC
 * day D is rebuilt here AS OF the end of D, with today's rules, on the evidence the live ranking reads:
 *   - PEOPLE: every (org, brand) pair's persons and timelines (lead-service), each person cut at the end of D
 *     (`asOfPerson`: only sends, replies, clicks, acts and CRM dates on or before D), then credited to the workflow that
 *     sent the email its outcome followed (`creditPerson`, the live attribution). MATURE at D = credited serve before
 *     D's cutoff (`maturityCutoffIso`, 21 days on both cold email legs); FLASH = served by D.
 *   - SPEND: the runs ledger per workflow version and run-start day (every org's leg campaigns); mature = runs started
 *     before D's cutoff, flash = started by D. Cost rows are today's ledger (the 08-24..10-02 send costs included).
 *   - WHO COULD BE PICKED on D: a workflow STARTED a run on the leg in the 21 days ending D (workflow-service records no
 *     date a workflow stopped running, so the runs ledger is the fact), AND, from the day stated assignments exist
 *     (2026-09-27), its leg assignment as of D is `active`.
 * Then the live code decides: per-slug evidence → dynasties (`rollUpLegEvidenceByDynasty`, screened visits on the visit
 * leg), maturity, the ONE leg order (`rankLegWorkflows`), the index points (`computeFleetIndexPoints`). Data dated
 * after D never moves D's point (`fleet-index-history.test.ts`).
 *
 * The meeting indexes are NOT rebuilt: the AI meeting booking pipe's evidence (who it acted on, which brands report
 * meetings) is read live from lead-service with no dated cut. Their series start with the recorder.
 */
import { computeFleetIndexPoints, FLEET_INDEXES, type FleetIndexPoint } from "./fleet-indexes.js";
import { buildFleetLegMaturity, rollUpLegEvidenceByDynasty, type DynastyLegEvidence, type SlugCostGroup } from "./fleet-leg-maturity.js";
import { rankLegWorkflows, type LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import { legMaturity, maturityCutoffIso } from "./maturity.js";
import type { EnginePerson } from "./revenue-engine.js";
import { HUMAN_CLICKED_KEY, isScreenedVisitLeg, SCREENED_CONTACTED_KEY, screenedCountsOfStats, screenVisitEvidence } from "./screened-visits.js";
import { asOfPerson, creditedSignal, creditPerson, type PersonTimeline } from "./serving-row-credit.js";

/**
 * A workflow may be picked on day D only if it started a run on the leg in the 21 days ending D: the cold email legs'
 * maturity horizon. The live rule reads whether workflow-service can run it TODAY, a status with no history; 7 days
 * dropped the best proven workflow while it still stood as the live index (rampart, last run 2026-10-13, published on
 * 2026-10-18).
 */
export const RUNNING_WINDOW_DAYS = 21;

const DAY_MS = 86_400_000;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Every UTC day from `first` to `last`, both included. */
export function dayRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

const endOfDayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - 1;

/** The leg's cutoff DAY when the index is read on `day` (the live rule: UTC midnight of the day − the leg's duration). */
export function cutoffDayOn(legKey: string, day: string): string {
  // A leg that waits for nothing: mature ≡ flash (everything up to and including the day).
  if (legMaturity(legKey).durationDays === 0) return addDays(day, 1);
  return maturityCutoffIso(legMaturity(legKey).durationDays, new Date(`${day}T12:00:00.000Z`)).slice(0, 10);
}

/** One leg the history is rebuilt for. */
export interface HistoryLeg {
  legKey: string;
  campaignIds: ReadonlySet<string>;
}

/** Metrics per (leg, half, slug), each a per-day DIFFERENCE array (value on day i = Σ diff[0..i]). */
const METRICS = ["contacted", "clicked", "positiveReplies", "screenedContacted", "humanClicked"] as const;
type Metric = (typeof METRICS)[number];
type Diff = Record<Metric, Float64Array>;

/** Person counts per day, accumulated pair by pair (`addPairPersons`), read with `personCountsOn`. */
export interface PersonHistory {
  days: readonly string[];
  /** `${legKey}\t${half}\t${slug}` → per-day difference arrays. */
  cells: Map<string, Diff>;
  /** Persons that could not be dated at all (no serve date, no dated send): in no past day. */
  undatedPersons: number;
}

export function emptyPersonHistory(days: readonly string[]): PersonHistory {
  return { days, cells: new Map(), undatedPersons: 0 };
}

function cellOf(h: PersonHistory, key: string): Diff {
  let c = h.cells.get(key);
  if (!c) {
    const n = h.days.length + 1;
    c = { contacted: new Float64Array(n), clicked: new Float64Array(n), positiveReplies: new Float64Array(n), screenedContacted: new Float64Array(n), humanClicked: new Float64Array(n) };
    h.cells.set(key, c);
  }
  return c;
}

/** The UTC days on which something about the person happened (the credit can only change on those days). */
function eventDays(person: EnginePerson, t: PersonTimeline | undefined): string[] {
  const out = new Set<string>();
  const add = (msOrIso: number | string | null | undefined) => {
    if (msOrIso === null || msOrIso === undefined) return;
    const at = typeof msOrIso === "number" ? msOrIso : Date.parse(msOrIso);
    if (Number.isFinite(at)) out.add(new Date(at).toISOString().slice(0, 10));
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
 * PURE. Add one (org, brand) pair's deduped persons to the history. For each person, between two of its event days its
 * credit is constant: it is computed once per event day on the person as of that day's end and spread over the days
 * up to the next event, flash from the day it holds, mature from the first day whose cutoff is past its serve.
 */
export function addPairPersons(
  h: PersonHistory,
  persons: readonly EnginePerson[],
  timelines: ReadonlyMap<string, PersonTimeline>,
  legs: readonly HistoryLeg[],
): void {
  const first = h.days[0];
  const last = h.days[h.days.length - 1];
  if (!first || !last) return;
  const indexOf = (day: string) => Math.round((Date.parse(`${day}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`)) / DAY_MS);
  for (const person of persons) {
    const t = timelines.get(person.leadId);
    if (!person.servedAt && !(t?.sends ?? []).some((x) => x.first !== null)) {
      h.undatedPersons += 1;
      continue;
    }
    const days = eventDays(person, t).map((d) => (d < first ? first : d)).filter((d, i, a) => d <= last && a.indexOf(d) === i);
    for (let k = 0; k < days.length; k++) {
      const day = days[k]!;
      const until = k + 1 < days.length ? indexOf(days[k + 1]!) : h.days.length;
      const cut = asOfPerson(person, t, endOfDayMs(day));
      if (!cut) continue;
      const credited = creditPerson(cut.person, cut.timeline, null);
      const campaignId = credited.campaignId ?? null;
      const slug = credited.workflowSlug ?? null;
      const servedDay = credited.servedAt ? credited.servedAt.slice(0, 10) : null;
      if (!campaignId || !slug || !servedDay) continue;
      const values: Record<Metric, number> = {
        contacted: creditedSignal(credited, "contacted") ? 1 : 0,
        clicked: creditedSignal(credited, "clicked") ? 1 : 0,
        positiveReplies: creditedSignal(credited, "positiveReply") ? 1 : 0,
        screenedContacted: creditedSignal(credited, "screenedContacted") ? 1 : 0,
        humanClicked: creditedSignal(credited, "humanClicked") ? 1 : 0,
      };
      if (!METRICS.some((m) => values[m] > 0)) continue;
      const from = indexOf(day);
      for (const leg of legs) {
        if (!leg.campaignIds.has(campaignId)) continue;
        // Mature on day D ⟺ served before D's cutoff (D − the leg's duration).
        const duration = legMaturity(leg.legKey).durationDays;
        const matureFrom = duration === 0 ? from : Math.max(from, indexOf(addDays(servedDay, duration + 1)));
        const spans: Array<[string, number]> = [["flash", from]];
        if (matureFrom < until) spans.push(["mature", matureFrom]);
        for (const [half, start] of spans) {
          if (start >= until) continue;
          const c = cellOf(h, `${leg.legKey}\t${half}\t${slug}`);
          for (const m of METRICS) {
            if (!values[m]) continue;
            c[m][start] += values[m];
            c[m][until] -= values[m];
          }
        }
      }
    }
  }
}

/** PURE. Per slug, the person counts of one leg on one day, in the mature cohort stats shape. */
export function personCountsOn(h: PersonHistory, legKey: string, half: "flash" | "mature", dayIndex: number): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  const prefix = `${legKey}\t${half}\t`;
  for (const [key, c] of h.cells) {
    if (!key.startsWith(prefix)) continue;
    const v = (m: Metric) => {
      let s = 0;
      for (let i = 0; i <= dayIndex; i++) s += c[m][i]!;
      return Math.round(s);
    };
    out.set(key.slice(prefix.length), {
      recipientsContacted: v("contacted"),
      recipientsClicked: v("clicked"),
      recipientsRepliesPositive: v("positiveReplies"),
      [SCREENED_CONTACTED_KEY]: v("screenedContacted"),
      [HUMAN_CLICKED_KEY]: v("humanClicked"),
    });
  }
  return out;
}

/** Spend and runs of one workflow version on one leg, per run-start UTC day (runs ledger). */
export interface DatedSlugSpend {
  legKey: string;
  workflowSlug: string;
  day: string;
  spentCents: number;
  runCount: number;
}

/** One leg-assignment change (`workflow_leg_assignment_changes`). */
export interface AssignmentChange {
  legKey: string;
  workflowDynastySlug: string;
  toState: string;
  decidedAt: string;
}

export interface WorkflowVersion {
  workflowSlug: string;
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
}

export interface HistoryInputs {
  /** Days to rebuild, oldest first (`personHistory.days`). */
  days: readonly string[];
  websiteVisitLeg: string;
  positiveReplyLeg: string;
  persons: PersonHistory;
  spend: readonly DatedSlugSpend[];
  /** Every change of the two legs, any order. Computation leg keys. */
  assignmentChanges: readonly AssignmentChange[];
  workflows: readonly WorkflowVersion[];
}

/** PURE. The leg ranking as it stood on `days[dayIndex]`. */
export function rankingOn(inputs: HistoryInputs, legKey: string, dayIndex: number): LegWorkflowRankingRow[] {
  const day = inputs.days[dayIndex]!;
  const cutoff = cutoffDayOn(legKey, day);
  const runningFrom = addDays(day, -(RUNNING_WINDOW_DAYS - 1));
  const flashCents = new Map<string, number>();
  const matureCents = new Map<string, number>();
  const ranRecently = new Set<string>();
  const dynastyOf = new Map(inputs.workflows.map((w) => [w.workflowSlug, w.workflowDynastySlug]));
  for (const s of inputs.spend) {
    if (s.legKey !== legKey || s.day > day) continue;
    flashCents.set(s.workflowSlug, (flashCents.get(s.workflowSlug) ?? 0) + s.spentCents);
    if (s.day < cutoff) matureCents.set(s.workflowSlug, (matureCents.get(s.workflowSlug) ?? 0) + s.spentCents);
    const dynasty = dynastyOf.get(s.workflowSlug);
    if (dynasty && s.day >= runningFrom && s.runCount > 0) ranRecently.add(dynasty);
  }
  const groups = (cents: Map<string, number>): SlugCostGroup[] =>
    [...cents].map(([slug, c]) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: c.toFixed(10), runCount: 1 }));
  const half = (cents: Map<string, number>, h: "flash" | "mature"): Map<string, DynastyLegEvidence> => {
    let costGroups = groups(cents);
    let stats = personCountsOn(inputs.persons, legKey, h, dayIndex);
    if (isScreenedVisitLeg(legKey)) {
      const screened = screenVisitEvidence(costGroups, stats, screenedCountsOfStats(stats));
      costGroups = screened.costGroups;
      stats = screened.emailStats;
    }
    return rollUpLegEvidenceByDynasty(inputs.workflows, costGroups, stats).byDynasty;
  };
  const dynasties = [...new Set(inputs.workflows.map((w) => w.workflowDynastySlug))];
  const byDynasty = buildFleetLegMaturity(legKey, dynasties, half(flashCents, "flash"), half(matureCents, "mature"));
  // Stated assignments exist from their first change; before it, the concept did not exist and every workflow counts.
  const legChanges = inputs.assignmentChanges.filter((c) => c.legKey === legKey).sort((a, b) => (a.decidedAt < b.decidedAt ? -1 : 1));
  const end = new Date(endOfDayMs(day)).toISOString();
  const assignments = new Map<string, "active" | "deprecated">();
  if (legChanges.length === 0 || legChanges[0]!.decidedAt > end) {
    for (const d of dynasties) assignments.set(d, "active");
  } else {
    for (const c of legChanges) {
      if (c.decidedAt > end) break;
      if (c.toState === "active" || c.toState === "deprecated") assignments.set(c.workflowDynastySlug, c.toState);
      else assignments.delete(c.workflowDynastySlug);
    }
  }
  const names = new Map<string, string | null>();
  for (const w of inputs.workflows) if (!names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName);
  return rankLegWorkflows({ byDynasty, names, assignments, executable: ranRecently, pipelineUsd: new Map(), billedSpendUsd: new Map() });
}

/** One recomputed point, on its day. */
export interface DatedIndexPoint {
  day: string;
  point: FleetIndexPoint;
}

/**
 * PURE. Every index point of every day of `inputs.days` (the meeting indexes excepted, see the module rule). An index's
 * series starts on its first day with a value: the days before it, when no workflow had been proven yet, are not points.
 */
export function recomputeIndexHistory(inputs: HistoryInputs): DatedIndexPoint[] {
  const all: DatedIndexPoint[] = [];
  for (let i = 0; i < inputs.days.length; i++) {
    const day = inputs.days[i]!;
    const points = computeFleetIndexPoints({
      websiteVisitRows: rankingOn(inputs, inputs.websiteVisitLeg, i),
      positiveReplyRows: rankingOn(inputs, inputs.positiveReplyLeg, i),
      meetingPipe: null,
    });
    for (const p of points) all.push({ day, point: { ...p, inputs: { ...p.inputs, asOfDay: day, runningWindowDays: RUNNING_WINDOW_DAYS } } });
  }
  const out: DatedIndexPoint[] = [];
  for (const def of FLEET_INDEXES) {
    const series = all.filter((p) => p.point.indexSlug === def.slug);
    const start = series.findIndex((p) => p.point.value !== null);
    if (start >= 0) out.push(...series.slice(start));
  }
  return out;
}

/** A stored row as the write plan reads it. */
export interface StoredIndexRow {
  indexSlug: string;
  day: string;
  basis: string;
  value: number | null;
  status: string;
  outcomes: number;
  contacted: number | null;
  workflowDynastySlug: string | null;
  unavailableReason: string | null;
  inputs: unknown;
}

const sameStored = (r: StoredIndexRow, p: FleetIndexPoint): boolean =>
  r.value === p.value &&
  r.status === p.status &&
  r.outcomes === p.outcomes &&
  r.contacted === p.contacted &&
  r.workflowDynastySlug === p.workflowDynastySlug &&
  r.unavailableReason === p.unavailableReason &&
  JSON.stringify(r.inputs) === JSON.stringify(p.inputs);

/**
 * PURE. What a run writes: a day a row was RECORDED live on is never touched; a recomputed row identical to the new point
 * is left alone (a re-run writes nothing); a new day is inserted, a changed recomputed day rewritten.
 */
export function planRecomputedWrites(points: readonly DatedIndexPoint[], stored: readonly StoredIndexRow[]): {
  writes: DatedIndexPoint[];
  skippedRecorded: number;
  unchanged: number;
} {
  const byKey = new Map(stored.map((r) => [`${r.indexSlug}|${r.day}`, r]));
  const writes: DatedIndexPoint[] = [];
  let skippedRecorded = 0;
  let unchanged = 0;
  for (const p of points) {
    const r = byKey.get(`${p.point.indexSlug}|${p.day}`);
    if (r && r.basis !== "recomputed") skippedRecorded += 1;
    else if (r && sameStored(r, p.point)) unchanged += 1;
    else writes.push(p);
  }
  return { writes, skippedRecorded, unchanged };
}
