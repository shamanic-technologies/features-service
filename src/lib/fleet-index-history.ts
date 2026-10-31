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
 *   - WHO COULD BE PICKED on D: the live rule as of the end of D (INDEX-HISTORY-MATURITY-AUDIT-1019). A dynasty can run
 *     when one of its versions was executable at that instant, read from workflow-service's own record of each
 *     version (created at, stopped being executable at; `executableDynastiesOn`); AND, from the day stated assignments
 *     exist (2026-09-27), its leg assignment as of D is `active`. Never a run or cost date: cost rows keep landing for
 *     weeks after a workflow is retired (reply handling on old sequences), so "last run" kept arcadia (retired
 *     2026-09-24) the money workflow until 2026-10-06 and ballad (retired 2026-10-06 16:26) on 2026-10-07.
 * Then the live code decides: per-slug evidence → dynasties (`rollUpLegEvidenceByDynasty`, screened visits on the visit
 * leg), maturity, the ONE leg order (`rankLegWorkflows`), the index points (`computeFleetIndexPoints`). Data dated
 * after D never moves D's point (`fleet-index-history.test.ts`).
 *
 * The meeting indexes, the meeting pipe's Research series and the outcome prices' meeting price are rebuilt too when the
 * AI Meeting Booking pipe's dated inputs are given (MEETING-COST-METHODS-1024, `meeting-pipe-history.ts`: acts dated by
 * lead-service's follow-up ledger, meetings and the reporting brands by its meeting facts). NOT rebuilt (series start
 * with the recorder): the client-median indexes (engaged lead, ROI), whose per-brand inputs this does not build.
 */
import { bestMeetingPipePick, computeFleetIndexPoints, FLEET_INDEXES, SCEO_FEATURE_SLUG, type FleetIndexPoint, type MeetingPipeEvidence } from "./fleet-indexes.js";
import { vendorPooled, vendorRankingRows, type PipeVendorTwin } from "./fleet-index-vendor.js";
import { assignmentsOn, executableOn, meetingPipeOn, type MeetingHistoryInputs } from "./meeting-pipe-history.js";
import { MEETING_BOOKING_FEATURE_SLUG, MEETING_BOOKING_LEG_KEY } from "./meeting-leg-fleet.js";
import { meetingBookedPrice, pickLegPrice } from "./outcome-prices.js";
import { MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG, meetingResearchPoints } from "./research/pipe-series.js";
import { MEETING_COST_OUTCOME_PRICES_SLUG, outcomePricesPoint } from "./research/meeting-cost-methods.js";
import type { LegMaturityFigures } from "./maturity.js";
import { buildFleetLegMaturity, rollUpLegEvidenceByDynasty, type DynastyLegEvidence, type SlugCostGroup } from "./fleet-leg-maturity.js";
import { rankLegWorkflows, type LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import { legMaturity, maturityCutoffIso } from "./maturity.js";
import type { EnginePerson } from "./revenue-engine.js";
import { HUMAN_CLICKED_KEY, isScreenedVisitLeg, SCREENED_CONTACTED_KEY, screenedCountsOfStats, screenVisitEvidence } from "./screened-visits.js";
import { asOfPerson, creditedSignal, creditPerson, type PersonTimeline } from "./serving-row-credit.js";

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

/**
 * PURE. The dynasties workflow-service could run at the end of `day`: one of their versions was created by then and
 * had not yet stopped being executable (`executableUntil` null = still executable today). The live rule
 * (`executableDynasties`: a version active in an active dynasty) read on the past.
 */
export function executableDynastiesOn(day: string, versions: readonly WorkflowVersion[]): Set<string> {
  return executableOn(day, versions);
}

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
      // No serve date: IN the mature cohort at once, as the live cohort keeps it (`servedInMatureCohort`).
      if (!campaignId || !slug) continue;
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
        const matureFrom = duration === 0 || !servedDay ? from : Math.max(from, indexOf(addDays(servedDay, duration + 1)));
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
  /** When workflow-service created the version (ISO). */
  createdAt: string;
  /** When it stopped being executable (ISO); null = executable today. */
  executableUntil: string | null;
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
  /**
   * The AI Meeting Booking pipe's dated inputs (MEETING-COST-METHODS-1024): with them the two meeting indexes, the meeting
   * pipe's Research series and the outcome prices' meeting price are rebuilt too. Absent = not rebuilt.
   */
  meeting?: MeetingHistoryInputs;
  /** Absorbed dynasty → its survivor (`fetchDynastyMerges`): leg assignments pool like the live read. Absent = none. */
  merges?: ReadonlyMap<string, string>;
  /**
   * The positive reply leg's spend WITH the sourcing its leads cost (`fed`, the outcome prices' basis: a reply priced
   * there includes finding the lead; the ranking and the index read `spend`, the pipe's own). Required with `meeting`.
   */
  fedSpend?: readonly DatedSlugSpend[];
}

/** PURE. The leg's per-dynasty figures as they stood on `days[dayIndex]` (what the ranking and the leg price read). */
export function legFiguresOn(inputs: HistoryInputs, legKey: string, dayIndex: number, spend: readonly DatedSlugSpend[] = inputs.spend): Map<string, LegMaturityFigures> {
  const day = inputs.days[dayIndex]!;
  const cutoff = cutoffDayOn(legKey, day);
  const flashCents = new Map<string, number>();
  const matureCents = new Map<string, number>();
  for (const s of spend) {
    if (s.legKey !== legKey) continue;
    if (s.day > day) continue;
    flashCents.set(s.workflowSlug, (flashCents.get(s.workflowSlug) ?? 0) + s.spentCents);
    if (s.day < cutoff) matureCents.set(s.workflowSlug, (matureCents.get(s.workflowSlug) ?? 0) + s.spentCents);
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
  return buildFleetLegMaturity(legKey, dynasties, half(flashCents, "flash"), half(matureCents, "mature"));
}

/** PURE. The leg ranking as it stood on `days[dayIndex]`. */
export function rankingOn(inputs: HistoryInputs, legKey: string, dayIndex: number): LegWorkflowRankingRow[] {
  const day = inputs.days[dayIndex]!;
  const dynasties = [...new Set(inputs.workflows.map((w) => w.workflowDynastySlug))];
  const byDynasty = legFiguresOn(inputs, legKey, dayIndex);
  // Stated assignments exist from their first change; before it, the concept did not exist and every workflow counts.
  const assignments = assignmentsOn(inputs.assignmentChanges, legKey, day, dynasties, inputs.merges);
  const names = new Map<string, string | null>();
  for (const w of inputs.workflows) if (!names.has(w.workflowDynastySlug)) names.set(w.workflowDynastySlug, w.workflowDynastyName);
  return rankLegWorkflows({ byDynasty, names, assignments, executable: executableDynastiesOn(day, inputs.workflows), pipelineUsd: new Map(), billedSpendUsd: new Map() });
}

/** One recomputed point, on its day. */
export interface DatedIndexPoint {
  day: string;
  point: FleetIndexPoint;
}

/** The stated leg rule as of `day`: deprecated or not executable then never prices the leg (`excludedFromLegPrice`). */
function excludedOn(changes: readonly AssignmentChange[], workflows: readonly WorkflowVersion[], legKey: string, day: string, merges?: ReadonlyMap<string, string>): Set<string> {
  const dynasties = [...new Set(workflows.map((w) => w.workflowDynastySlug))];
  const executable = executableOn(day, workflows);
  const out = new Set([...assignmentsOn(changes, legKey, day, dynasties, merges)].filter(([, st]) => st === "deprecated").map(([d]) => d));
  for (const d of dynasties) if (!executable.has(d)) out.add(d);
  return out;
}

function fedSpendOf(inputs: HistoryInputs): readonly DatedSlugSpend[] {
  if (!inputs.fedSpend) throw new Error("fleet index history: the outcome prices' history needs the reply leg's fed spend");
  return inputs.fedSpend;
}

/** Every series this history writes, the indexes first. */
const HISTORY_SLUGS = [...FLEET_INDEXES.map((d) => d.slug), MEETING_RESEARCH_BEST_SLUG, MEETING_RESEARCH_MEDIAN_SLUG, MEETING_COST_OUTCOME_PRICES_SLUG];

/**
 * PURE. Every index point of every day of `inputs.days`; the meeting indexes, the meeting pipe's Research series and the
 * outcome prices' meeting price only when `inputs.meeting` is given. A series starts on its first day with a value: the
 * days before it, when no workflow had been proven yet, are not points.
 */
export function recomputeIndexHistory(inputs: HistoryInputs): DatedIndexPoint[] {
  const all: DatedIndexPoint[] = [];
  for (let i = 0; i < inputs.days.length; i++) {
    const day = inputs.days[i]!;
    const positiveReplyRows = rankingOn(inputs, inputs.positiveReplyLeg, i);
    const meeting = inputs.meeting ? meetingPipeOn(inputs.meeting, day) : null;
    const meetingPipe = meeting ? { rows: meeting.rows, pooled: meeting.fleet.pooled } : null;
    const points = computeFleetIndexPoints({
      websiteVisitRows: rankingOn(inputs, inputs.websiteVisitLeg, i),
      positiveReplyRows,
      meetingPipe,
    });
    if (meeting && meetingPipe) {
      points.push(...meetingResearchPoints(bestMeetingPipePick(meetingPipe), meeting.fleet.byOrg));
      // The outcome prices' meeting price as of the day: the same pick on both legs (`computeOutcomePrices`).
      const replyLeg = pickLegPrice({
        legKey: inputs.positiveReplyLeg,
        featureSlug: SCEO_FEATURE_SLUG,
        byDynasty: legFiguresOn(inputs, inputs.positiveReplyLeg, i, fedSpendOf(inputs)),
        excluded: excludedOn(inputs.assignmentChanges, inputs.workflows, inputs.positiveReplyLeg, day, inputs.merges),
        campaignCount: 1,
      });
      const meetingLeg = pickLegPrice({
        legKey: MEETING_BOOKING_LEG_KEY,
        featureSlug: MEETING_BOOKING_FEATURE_SLUG,
        byDynasty: new Map(meeting.fleet.byDynasty),
        excluded: excludedOn(inputs.meeting!.assignmentChanges, inputs.meeting!.workflows, MEETING_BOOKING_LEG_KEY, day, inputs.meeting!.merges),
        campaignCount: inputs.meeting!.campaigns.length,
      });
      const price = outcomePricesPoint({ ...meetingBookedPrice(replyLeg, meetingLeg), legs: [replyLeg, meetingLeg] });
      if (price) points.push(price);
    }
    for (const p of points) all.push({ day, point: { ...p, inputs: { ...p.inputs, asOfDay: day } } });
  }
  const out: DatedIndexPoint[] = [];
  for (const slug of HISTORY_SLUGS) {
    const series = all.filter((p) => p.point.indexSlug === slug);
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

/** JSON with object keys sorted: a jsonb column hands keys back in its own order, never the written one. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const sameStored = (r: StoredIndexRow, p: FleetIndexPoint): boolean =>
  r.value === p.value &&
  r.status === p.status &&
  r.outcomes === p.outcomes &&
  r.contacted === p.contacted &&
  r.workflowDynastySlug === p.workflowDynastySlug &&
  r.unavailableReason === p.unavailableReason &&
  canonical(r.inputs) === canonical(p.inputs);

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

/** The dated spend the history reads, on the VENDOR basis and its unpriced twin (PUBLIC-VENDOR-COST-1031). */
export interface VendorHistoryInputs {
  /** Per (leg, version, run-start day): the cold email legs' spend at real vendor cost (same rows as `inputs.spend`). */
  spend: readonly DatedSlugSpend[];
  /** The same rows' billed spend no vendor cost prices. */
  unpricedSpend: readonly DatedSlugSpend[];
  /** The meeting pipe's per (campaign, version, day) spend on each basis (same rows as `inputs.meeting.spend`). */
  meetingSpend?: MeetingHistoryInputs["spend"];
  meetingUnpricedSpend?: MeetingHistoryInputs["spend"];
}

/**
 * PURE. The PUBLIC indexes of every day of `inputs.days` at real VENDOR cost (PUBLIC-VENDOR-COST-1031): each day's picks
 * are the BILLED history's (`rankingOn`, `meetingPipeOn`: who a client's money went to), each pick's money read on the
 * vendor twin of the same rows (`lib/fleet-index-vendor.ts`). Only the public index series; a series starts on its first
 * day with a value, like the billed one.
 */
export function recomputeVendorIndexHistory(inputs: HistoryInputs, vendor: VendorHistoryInputs): DatedIndexPoint[] {
  const all: DatedIndexPoint[] = [];
  const twinOn = (legKey: string, i: number): PipeVendorTwin => ({
    vendor: legFiguresOn(inputs, legKey, i, vendor.spend),
    unpriced: legFiguresOn(inputs, legKey, i, vendor.unpricedSpend),
  });
  for (let i = 0; i < inputs.days.length; i++) {
    const day = inputs.days[i]!;
    let meetingPipe: MeetingPipeEvidence | null = null;
    if (inputs.meeting && vendor.meetingSpend && vendor.meetingUnpricedSpend) {
      const billed = meetingPipeOn(inputs.meeting, day);
      const v = meetingPipeOn({ ...inputs.meeting, spend: vendor.meetingSpend }, day).fleet;
      const u = meetingPipeOn({ ...inputs.meeting, spend: vendor.meetingUnpricedSpend }, day).fleet;
      meetingPipe = {
        rows: vendorRankingRows(billed.rows, { vendor: new Map(v.byDynasty), unpriced: new Map(u.byDynasty) }),
        pooled: vendorPooled(billed.fleet.pooled, v.pooled.spentByDynasty, u.pooled.spentByDynasty),
      };
    }
    const points = computeFleetIndexPoints({
      websiteVisitRows: vendorRankingRows(rankingOn(inputs, inputs.websiteVisitLeg, i), twinOn(inputs.websiteVisitLeg, i)),
      positiveReplyRows: vendorRankingRows(rankingOn(inputs, inputs.positiveReplyLeg, i), twinOn(inputs.positiveReplyLeg, i)),
      meetingPipe,
    });
    for (const p of points) all.push({ day, point: { ...p, inputs: { ...p.inputs, asOfDay: day, costBasis: "vendor" } } });
  }
  const out: DatedIndexPoint[] = [];
  for (const def of FLEET_INDEXES) {
    const series = all.filter((p) => p.point.indexSlug === def.slug);
    const start = series.findIndex((p) => p.point.value !== null);
    if (start >= 0) out.push(...series.slice(start));
  }
  return out;
}
