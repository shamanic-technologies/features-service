/**
 * THE TWO RESEARCH ARTICLES OVER TIME, PER PIPE (owner 2026-10-18, MB-INDEX-PIPES-1018: « Research doit contenir les deux
 * articles de research au cours du temps »). Pure.
 *
 *  (a) BEST WORKFLOW: what one outcome costs with the pipe's best MATURE workflow that can still run, at each point in
 *      time (the figure the public index publishes). On a cold email pipe, each month reads every workflow's evidence
 *      CUMULATIVE through that month (the bars' own basis, scaled onto the ranking row), and a workflow competes from the
 *      month its outcomes reach the maturity bar: the last month IS today's ranking row.
 *  (b) CLIENT MEDIAN: what one outcome costs the median client on the pipe (each client's own spend ÷ its own outcomes,
 *      cumulative). A client that spent with ZERO outcomes counts as the most expensive, never dropped, so the median is
 *      not flattered; a median landing on such a client reads "no outcome", never a number.
 *
 * The meeting pipe (Positive reply -> Meeting booked) has no dated evidence per client yet: its series are the points
 * recorded day after day (`routes/fleet-indexes.ts`, research slugs below), today's computed live.
 */
import { indexStatus, type FleetIndexPoint, type FleetIndexStatus, type MeetingPipePick } from "../fleet-indexes.js";
import { counts, judge, type BucketFigures, type PipeTerms, type ResearchBucket } from "./studies.js";
import { n, usd } from "./format.js";
import type { StratumCounts, Verdict } from "./verdict.js";
import type { ResearchPoint, ResearchStudy } from "./types.js";

/** The meeting pipe's recorded series (rows of `fleet_index_points`, never served by `/public/indexes`). */
export const MEETING_RESEARCH_BEST_SLUG = "research:meeting-booking:best-workflow";
export const MEETING_RESEARCH_MEDIAN_SLUG = "research:meeting-booking:client-median";

export interface BestPoint {
  /** `YYYY-MM` or `YYYY-MM-DD`. */
  period: string;
  key: string | null;
  label: string;
  costPerOutcomeUsd: number;
  figures: BucketFigures;
  mature: boolean;
}

export interface MedianPoint {
  period: string;
  /** Clients that spent on the pipe. */
  clients: number;
  clientsWithoutOutcome: number;
  /** Null when the median client has no outcome (`medianHasNoOutcome`). */
  medianUsd: number | null;
  medianHasNoOutcome: boolean;
}

export interface ClientFigure {
  spentUsd: number;
  outcomes: number;
}

/** PURE. The median client's cost per outcome; a client with spend and no outcome is the most expensive. Null = nobody spent. */
export function clientMedian(clients: readonly ClientFigure[]): Omit<MedianPoint, "period"> | null {
  const spent = clients.filter((c) => c.spentUsd > 0);
  if (!spent.length) return null;
  const costs = spent.map((c) => (c.outcomes > 0 ? c.spentUsd / c.outcomes : Infinity)).sort((a, b) => a - b);
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  const finite = Number.isFinite(median);
  return {
    clients: spent.length,
    clientsWithoutOutcome: spent.filter((c) => c.outcomes <= 0).length,
    medianUsd: finite ? median : null,
    medianHasNoOutcome: !finite,
  };
}

/**
 * PURE. Month by month, the cheapest MATURE workflow among `eligible` (runnable today), on its evidence cumulative through
 * the month, read on the page's view (each bucket's months are its view's half). Mature = out of Learning, the maturity
 * rule whatever the view: keyed on `basis`, the Flash view had no candidate at all and read "No workflow has reached 1
 * positive reply yet" beside Ballad's 47 (BEST-OVER-TIME-FLASH-1024). A month where none has reached the bar has no point.
 */
export function bestWorkflowByMonth(buckets: readonly ResearchBucket[], eligible: ReadonlySet<string>, outcomesRequired: number): BestPoint[] {
  const candidates = buckets.filter((b) => !b.learning && eligible.has(b.key) && b.months);
  const months = [...new Set(candidates.flatMap((b) => b.months!.map((m) => m.month)))].sort();
  const out: BestPoint[] = [];
  for (const month of months) {
    let best: BestPoint | null = null;
    for (const b of candidates) {
      const f = { spentUsd: 0, contacted: 0, outcomes: 0 };
      for (const m of b.months!) {
        if (m.month > month) continue;
        f.spentUsd += m.spentUsd;
        f.contacted += m.contacted;
        f.outcomes += m.outcomes;
      }
      if (f.outcomes < outcomesRequired || f.outcomes <= 0 || f.spentUsd <= 0) continue;
      const cost = f.spentUsd / f.outcomes;
      if (!best || cost < best.costPerOutcomeUsd || (cost === best.costPerOutcomeUsd && b.key < best.key!)) {
        best = { period: month, key: b.key, label: b.label, costPerOutcomeUsd: cost, figures: f, mature: true };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** PURE. Month by month, the median client on strata keyed `<org>|YYYY-MM`, each client cumulative through the month. */
export function clientMedianByMonth(strata: Readonly<Record<string, StratumCounts>>): MedianPoint[] {
  const byClient = new Map<string, Map<string, StratumCounts>>();
  for (const [key, s] of Object.entries(strata)) {
    const cut = key.lastIndexOf("|");
    const client = key.slice(0, cut);
    const month = key.slice(cut + 1);
    const m = byClient.get(client) ?? new Map<string, StratumCounts>();
    m.set(month, s);
    byClient.set(client, m);
  }
  const months = [...new Set([...byClient.values()].flatMap((m) => [...m.keys()]))].sort();
  const out: MedianPoint[] = [];
  for (const month of months) {
    const clients = [...byClient.values()].map((m) => {
      let spentUsd = 0;
      let outcomes = 0;
      for (const [mo, s] of m) {
        if (mo > month) continue;
        spentUsd += s.spend;
        outcomes += s.outcomes;
      }
      return { spentUsd, outcomes };
    });
    const med = clientMedian(clients);
    if (med) out.push({ period: month, ...med });
  }
  return out;
}

const verdictOf = (status: FleetIndexStatus, reason: string): Verdict => ({ kind: status === "robust" ? "conclusion" : status, reason });

/**
 * PURE. The two studies of one pipe: `<pipe>-best-workflow-over-time` and `<pipe>-client-median-over-time`.
 * `periodLabel` prints a period ("Sep", "Oct 18"); `byWhat` names the cadence ("by month", "day by day").
 */
export function overTimeStudies(t: PipeTerms, best: readonly BestPoint[], median: readonly MedianPoint[], periodLabel: (p: string) => string, byWhat: string, note: string): ResearchStudy[] {
  const lastBest = best[best.length - 1];
  const bestPoints: ResearchPoint[] = best.map((p) => ({
    ...(p.key ? { key: p.key } : {}),
    label: periodLabel(p.period),
    value: p.costPerOutcomeUsd,
    display: usd(p.costPerOutcomeUsd),
    note: `${p.label} · ${counts(t, p.figures)} · ${usd(p.figures.spentUsd)} spent`,
    thin: !p.mature,
  }));
  const bestStatus = lastBest ? indexStatus(Math.round(lastBest.figures.outcomes), lastBest.mature) : "noise";
  const bestBase = {
    id: `${t.pipe}-best-workflow-over-time`,
    pipe: t.pipe,
    topic: "cost" as const,
    goal: "roi" as const,
    question: `What does a ${t.noun} cost with our best workflow, over time?`,
    status: lastBest ? ("measured" as const) : ("not_enough_data" as const),
    headline: lastBest
      ? `${usd(lastBest.costPerOutcomeUsd)} per ${t.noun} with ${lastBest.label}, our best ${lastBest.mature ? "proven " : ""}workflow today.`
      : `No workflow has reached ${n(t.outcomesRequired)} ${t.outcomesRequired === 1 ? t.noun : t.nounPlural} yet.`,
    winner: lastBest?.key ?? null,
    result: lastBest ? { display: usd(lastBest.costPerOutcomeUsd), unit: `per ${t.noun}, best workflow`, sample: `${counts(t, lastBest.figures)} · ${usd(lastBest.figures.spentUsd)} spent` } : null,
    crowned: false,
    charts: bestPoints.length
      ? [{ kind: "months" as const, title: `Best workflow: cost per ${t.noun} ${byWhat}`, lowerIsBetter: true, points: bestPoints, note }]
      : [],
    conclusion: [
      `Each point is the cheapest workflow that can still run and has ${n(t.outcomesRequired)} ${t.outcomesRequired === 1 ? t.noun : t.nounPlural} behind it, on everything it did up to that point: the figure the public index publishes.`,
    ],
  };
  const lastMed = median[median.length - 1];
  const medPoints: ResearchPoint[] = median
    .filter((p) => p.medianUsd !== null)
    .map((p) => ({
      label: periodLabel(p.period),
      value: p.medianUsd!,
      display: usd(p.medianUsd!),
      note: `${n(p.clients)} ${p.clients === 1 ? "client" : "clients"}, ${n(p.clientsWithoutOutcome)} with no ${t.noun} yet`,
      thin: p.clients - p.clientsWithoutOutcome < 3,
    }));
  const withOutcome = lastMed ? lastMed.clients - lastMed.clientsWithoutOutcome : 0;
  const medStatus: FleetIndexStatus = !lastMed || lastMed.medianHasNoOutcome || withOutcome < 3 ? "noise" : withOutcome < 10 ? "signal" : "robust";
  const medBase = {
    id: `${t.pipe}-client-median-over-time`,
    pipe: t.pipe,
    topic: "cost" as const,
    goal: "roi" as const,
    question: `What does a ${t.noun} cost the median client, over time?`,
    status: lastMed && lastMed.medianUsd !== null ? ("measured" as const) : ("not_enough_data" as const),
    headline: !lastMed
      ? `No client has spent on this pipe yet.`
      : lastMed.medianUsd !== null
        ? `${usd(lastMed.medianUsd)} per ${t.noun} for the median client, across ${n(lastMed.clients)} clients.`
        : `The median client has no ${t.noun} yet: ${n(lastMed.clientsWithoutOutcome)} of ${n(lastMed.clients)} clients have none.`,
    winner: null,
    result: lastMed && lastMed.medianUsd !== null ? { display: usd(lastMed.medianUsd), unit: `per ${t.noun}, median client`, sample: `${n(lastMed.clients)} clients, ${n(lastMed.clientsWithoutOutcome)} with no ${t.noun} yet` } : null,
    crowned: false,
    charts: medPoints.length ? [{ kind: "months" as const, title: `Median client: cost per ${t.noun} ${byWhat}`, lowerIsBetter: true, points: medPoints, note }] : [],
    conclusion: [
      `Each client's cost is its own spend on the pipe divided by its own ${t.nounPlural}, everything up to that point. A client that spent with no ${t.noun} counts as the most expensive, never left out.`,
    ],
  };
  return [
    judge(bestBase, verdictOf(bestStatus, lastBest ? `${n(Math.round(lastBest.figures.outcomes))} ${t.nounPlural} behind the best workflow${lastBest.mature ? "" : ", none proven yet"}.` : "No workflow measured yet.")),
    judge(medBase, verdictOf(medStatus, lastMed ? `${n(withOutcome)} of ${n(lastMed.clients)} clients have a ${t.noun}.` : "No client spent yet.")),
  ];
}

/** PURE. Today's two meeting-pipe points, as recorded rows (`fleet_index_points`): the best workflow (or pipe) and the median client. */
export function meetingResearchPoints(pick: MeetingPipePick | null, clients: readonly ClientFigure[]): FleetIndexPoint[] {
  const med = clientMedian(clients);
  return [
    {
      indexSlug: MEETING_RESEARCH_BEST_SLUG,
      value: pick ? pick.costPerMeetingUsd : null,
      status: pick ? indexStatus(pick.outcomes, pick.mature) : "noise",
      outcomes: pick?.outcomes ?? 0,
      contacted: pick?.contacted ?? null,
      workflowDynastySlug: pick?.workflowDynastySlug ?? null,
      workflowDynastyName: pick?.workflowDynastyName ?? null,
      unavailableReason: pick ? null : "no_meeting_on_pipe",
      inputs: { source: pick?.source ?? null, spentUsd: pick?.spentUsd ?? null, mature: pick ? String(pick.mature) : null, ratePct: pick?.ratePct ?? null },
    },
    {
      indexSlug: MEETING_RESEARCH_MEDIAN_SLUG,
      value: med?.medianUsd ?? null,
      status: "noise",
      outcomes: 0,
      contacted: null,
      workflowDynastySlug: null,
      workflowDynastyName: null,
      unavailableReason: !med ? "no_client_spent" : med.medianHasNoOutcome ? "median_client_has_no_meeting" : null,
      inputs: { clients: med?.clients ?? 0, clientsWithoutOutcome: med?.clientsWithoutOutcome ?? 0, medianHasNoOutcome: med ? String(med.medianHasNoOutcome) : null },
    },
  ];
}

/** A recorded row as read back (the columns this reads). */
export interface RecordedPoint {
  day: string;
  value: number | null;
  outcomes: number;
  contacted: number | null;
  workflowDynastySlug: string | null;
  workflowDynastyName: string | null;
  inputs: unknown;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

/** PURE. The meeting pipe's two series from its recorded days; `today` (computed live) replaces the row of its day. */
export function meetingSeriesOf(
  recordedBest: readonly RecordedPoint[],
  recordedMedian: readonly RecordedPoint[],
  today: { day: string; points: FleetIndexPoint[] },
  labelOf: (dynasty: string) => string,
): { best: BestPoint[]; median: MedianPoint[] } {
  const asRow = (p: FleetIndexPoint): RecordedPoint => ({ day: today.day, value: p.value, outcomes: p.outcomes, contacted: p.contacted, workflowDynastySlug: p.workflowDynastySlug, workflowDynastyName: p.workflowDynastyName, inputs: p.inputs });
  const withToday = (rows: readonly RecordedPoint[], slug: string) => {
    const t = today.points.find((p) => p.indexSlug === slug);
    return [...rows.filter((r) => r.day !== today.day), ...(t ? [asRow(t)] : [])].sort((a, b) => (a.day < b.day ? -1 : 1));
  };
  const best = withToday(recordedBest, MEETING_RESEARCH_BEST_SLUG).flatMap((r): BestPoint[] => {
    if (r.value === null) return [];
    const inputs = (r.inputs ?? {}) as Record<string, unknown>;
    return [
      {
        period: r.day,
        key: r.workflowDynastySlug,
        label: r.workflowDynastySlug ? labelOf(r.workflowDynastySlug) : "Every workflow of the pipe",
        costPerOutcomeUsd: r.value,
        figures: { spentUsd: num(inputs.spentUsd), contacted: r.contacted ?? 0, outcomes: r.outcomes },
        mature: inputs.mature === "true",
      },
    ];
  });
  const median = withToday(recordedMedian, MEETING_RESEARCH_MEDIAN_SLUG).flatMap((r): MedianPoint[] => {
    const inputs = (r.inputs ?? {}) as Record<string, unknown>;
    const clients = num(inputs.clients);
    if (clients <= 0) return [];
    return [{ period: r.day, clients, clientsWithoutOutcome: num(inputs.clientsWithoutOutcome), medianUsd: r.value, medianHasNoOutcome: inputs.medianHasNoOutcome === "true" }];
  });
  return { best, median };
}

