/**
 * ONE STUDY PER QUESTION, written from per-bucket figures (LIVE-RESEARCH-1018). Pure: the IO half
 * (`lib/research/evidence.ts`) hands each pipe's buckets in, this module writes the question, the bars, the month
 * curve, the one-line result, the conclusion lines and the verdict, so the page divides nothing.
 *
 * Doctrine carried over from the nightly snapshot (`apps/landing/scripts/blog-data/research.mjs`, distribute.you):
 *  - One figure = one pipe (leg x channel). ROI is read as COST PER OUTCOME: every pipe buys one outcome.
 *  - The WINNER is the top bar, Learning or not; `crowned` only when the verdict is a conclusion.
 *  - Every bucket that reached anybody is drawn (no volume filter); one short of the maturity rule reads Learning.
 * What the live read changes ON PURPOSE (stated on the page under every chart):
 *  - The figures are this service's own per-workflow evidence on the leg (the leg workflow ranking's), so a study and
 *    the Workflows page can never state two figures for one workflow. A bucket is read MATURE once its mature
 *    outcomes reach the leg's bar, else FLASH (everything to date) and marked Learning: the ranking's rule.
 *  - A RATE is per PERSON emailed (a positive reply / a human visit is a person's), not per email sent.
 */
import { MONTHS, monthLabel, n, pctText, usd } from "./format.js";
import { compareVerdict, headlineFor, likeForLike, MIN_OUTCOMES, poissonInterval, sharedPairs, type Arm, type Strata, type StratumCounts, type Verdict } from "./verdict.js";
import type { ResearchChart, ResearchGoal, ResearchPipeId, ResearchPoint, ResearchStudy, ResearchTopic } from "./types.js";

/** What one pipe buys, in words. */
export interface PipeTerms {
  pipe: ResearchPipeId;
  noun: string;
  nounPlural: string;
  /** Who the rate is counted over, plural ("people emailed"). */
  exposureNoun: string;
  exposureNounOne: string;
  outcomesRequired: number;
  /** The month the maturity cutoff falls inside (`YYYY-MM`), null when the cutoff is the 1st or the leg waits for nothing. */
  partialMonth: string | null;
  /** The methodology line under every chart. */
  note: string;
}

export interface BucketFigures {
  spentUsd: number;
  contacted: number;
  outcomes: number;
}

export interface BucketMonth extends BucketFigures {
  /** `YYYY-MM`. */
  month: string;
}

/** One bar of a study: a workflow, a model, a template, a side of a split. */
export interface ResearchBucket {
  key: string;
  label: string;
  /** The half the bar is read on (`mature` once its mature outcomes reach the bar, else `flash`). */
  basis: "mature" | "flash";
  figures: BucketFigures;
  /** Below the leg's maturity rule. */
  learning: boolean;
  /** One entry per month on the bar's own basis, summing to `figures`; null when the pipe is not dated by month. */
  months: BucketMonth[] | null;
  /** Per stratum (`<org>|<month>`) on the bar's own basis; null when the pipe is not split by client and month. */
  strata: Record<string, StratumCounts> | null;
}

const costOf = (f: BucketFigures): number | null => (f.outcomes > 0 && f.spentUsd > 0 ? f.spentUsd / f.outcomes : null);
const rateOf = (f: BucketFigures): number | null => (f.contacted > 0 ? (100 * f.outcomes) / f.contacted : null);

/** "18 website visits · 720 people emailed". A dated part scaled onto its total can carry a fraction: printed whole. */
export const counts = (t: PipeTerms, f: BucketFigures): string => {
  const o = Math.round(f.outcomes);
  const c = Math.round(f.contacted);
  return `${n(o)} ${o === 1 ? t.noun : t.nounPlural} · ${n(c)} ${c === 1 ? t.exposureNounOne : t.exposureNoun}`;
};
const rateSentence = (t: PipeTerms, pct: number) => `a ${pctText(pct)} ${t.noun} rate`;
const rateLabel = (t: PipeTerms) => `${t.noun} rate, % of ${t.exposureNoun}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const costTitle = (t: PipeTerms) => `Cost per ${t.noun} (USD, lower is better)`;
export const rateTitle = (t: PipeTerms) => `${cap(t.noun)} rate, % of ${t.exposureNoun} (higher is better)`;

const byCost = (a: ResearchBucket, b: ResearchBucket) => costOf(a.figures)! - costOf(b.figures)! || b.figures.outcomes - a.figures.outcomes || (a.key < b.key ? -1 : 1);
const byRate = (a: ResearchBucket, b: ResearchBucket) =>
  rateOf(b.figures)! - rateOf(a.figures)! || b.figures.contacted - a.figures.contacted || (a.key < b.key ? -1 : 1);

export const pricedSorted = (rows: readonly ResearchBucket[]) => rows.filter((r) => costOf(r.figures) !== null).sort(byCost);
export const drawnSorted = (rows: readonly ResearchBucket[]) => rows.filter((r) => rateOf(r.figures) !== null).sort(byRate);

export function costBars(t: PipeTerms, rows: readonly ResearchBucket[], { keyed = false, ordinal = false } = {}): ResearchPoint[] {
  const priced = ordinal ? rows.filter((r) => costOf(r.figures) !== null) : pricedSorted(rows);
  return priced.map((r) => {
    const c = costOf(r.figures)!;
    return { ...(keyed ? { key: r.key } : {}), label: r.label, value: Number(c.toFixed(2)), display: usd(c), note: counts(t, r.figures), thin: r.learning };
  });
}

export function rateBars(t: PipeTerms, rows: readonly ResearchBucket[], { keyed = false, ordinal = false } = {}): ResearchPoint[] {
  const drawn = ordinal ? rows.filter((r) => rateOf(r.figures) !== null) : drawnSorted(rows);
  return drawn.map((r) => {
    const v = rateOf(r.figures)!;
    return { ...(keyed ? { key: r.key } : {}), label: r.label, value: Number(v.toFixed(2)), display: pctText(v), note: counts(t, r.figures), thin: r.learning };
  });
}

const IN_PROGRESS = "month in progress";

function monthLine(t: PipeTerms, months: readonly BucketMonth[], kind: "cost" | "rate"): ResearchPoint[] {
  return months
    .filter((m) => (kind === "cost" ? costOf(m) !== null : rateOf(m) !== null))
    .map((m) => {
      const v = kind === "cost" ? costOf(m)! : rateOf(m)!;
      const partial = m.month === t.partialMonth;
      return {
        label: monthLabel(m.month),
        value: Number(v.toFixed(2)),
        display: kind === "cost" ? usd(v) : pctText(v),
        note: partial ? `${counts(t, m)} · ${IN_PROGRESS}` : counts(t, m),
        thin: Math.round(m.outcomes) < t.outcomesRequired,
        ...(partial ? { partial: true } : {}),
      };
    });
}

/** The average SINCE INCEPTION at the end of each month: everything spent (or reached) up to it over every outcome up to it. */
function sinceInception(t: PipeTerms, months: readonly BucketMonth[], kind: "cost" | "rate"): ResearchPoint[] {
  let spend = 0;
  let got = 0;
  let reached = 0;
  const out: ResearchPoint[] = [];
  for (const m of months) {
    spend += m.spentUsd;
    got += m.outcomes;
    reached += m.contacted;
    if (kind === "cost" ? got === 0 || spend <= 0 : reached === 0) continue;
    const v = kind === "cost" ? spend / got : (100 * got) / reached;
    const partial = m.month === t.partialMonth;
    out.push({
      label: monthLabel(m.month),
      value: Number(v.toFixed(2)),
      display: kind === "cost" ? usd(v) : pctText(v),
      note: `${counts(t, { spentUsd: spend, contacted: reached, outcomes: got })} to date${partial ? ` · ${IN_PROGRESS}` : ""}`,
      thin: Math.round(got) < t.outcomesRequired,
      ...(partial ? { partial: true } : {}),
    });
  }
  return out;
}

export function monthsChart(t: PipeTerms, months: readonly BucketMonth[], kind: "cost" | "rate", subject: string): ResearchChart {
  const what = kind === "cost" ? `cost per ${t.noun}` : `${t.noun} rate`;
  return {
    kind: "months",
    title: `${subject}: ${what} by month`,
    lowerIsBetter: kind === "cost",
    points: monthLine(t, months, kind),
    cumulative: { title: `${subject}: average since inception`, points: sinceInception(t, months, kind) },
    note: t.note,
  };
}

function movement(points: readonly ResearchPoint[]): string | null {
  if (points.length < 2) return null;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  return `${a.display} in ${a.label}, ${b.display} in ${b.label}`;
}

const arm = (r: ResearchBucket | undefined): Arm | null =>
  r ? { label: r.label, outcomes: r.figures.outcomes, exposure: r.figures.contacted, spend: r.figures.spentUsd } : null;

/** The strata of a cut, keyed on each bucket's LABEL (what `compareVerdict` names). Null when any bucket has none. */
export function strataOf(rows: readonly ResearchBucket[]): Strata | null {
  if (rows.some((r) => r.strata === null)) return null;
  return Object.fromEntries(rows.map((r) => [r.label, r.strata!]));
}

/** Leader and runner-up of a cut, in the order its chart draws them; `m` = how many others the leader was ranked against. */
export function pairOf(rows: readonly ResearchBucket[], goal: ResearchGoal): { a?: ResearchBucket; b?: ResearchBucket; m: number } {
  const drawn = rows.filter((r) => r.figures.contacted > 0 || r.figures.spentUsd > 0);
  if (goal === "rate") {
    const sorted = drawnSorted(drawn);
    return { a: sorted[0], b: sorted[1], m: drawn.length - 1 };
  }
  const priced = pricedSorted(drawn);
  const unpriced = drawn.filter((r) => costOf(r.figures) === null).sort((x, y) => y.figures.spentUsd - x.figures.spentUsd);
  return { a: priced[0], b: priced[1] ?? unpriced[0], m: drawn.length - 1 };
}

const LFL_MIN = 5;
const x2 = (r: number) => `${r.toFixed(2)}x`;
/** Same clients, same months: the winner against the three others it shares the most people with. */
function likeForLikeLines(t: PipeTerms, rows: readonly ResearchBucket[], winner: ResearchBucket, goal: ResearchGoal): string[] {
  if (!winner.strata) return [];
  const out: Array<{ other: string; l: ReturnType<typeof likeForLike> }> = [];
  for (const other of rows) {
    if (other === winner || !other.strata) continue;
    const pairs = sharedPairs(winner.strata, other.strata);
    if (pairs.length) out.push({ other: other.label, l: likeForLike(pairs) });
  }
  if (!out.length) return [`Same clients, same months: ${winner.label} ran for no client in a month another one also ran for, so it has no like-for-like comparison.`];
  return out
    .sort((p, q) => q.l.b.exposure - p.l.b.exposure)
    .slice(0, 3)
    .map(({ other, l }) => {
      const tally = `${n(Math.round(l.a.outcomes))} ${l.a.outcomes === 1 ? t.noun : t.nounPlural} in ${n(Math.round(l.a.exposure))} ${t.exposureNoun} against ${n(Math.round(l.b.outcomes))} in ${n(Math.round(l.b.exposure))}`;
      if (l.a.outcomes < LFL_MIN || l.b.outcomes < LFL_MIN || !l.rate) return `Same clients, same months, ${winner.label} against ${other}: ${tally}, under ${LFL_MIN} on one side, so no ratio.`;
      if (goal === "rate") return `Same clients, same months, ${winner.label} gets ${x2(l.rate.ratio)} the ${t.nounPlural} per person of ${other} (95% interval ${x2(l.rate.lo)} to ${x2(l.rate.hi)}; ${tally}).`;
      if (!l.cost) return `Same clients, same months, ${winner.label} gets ${x2(l.rate.ratio)} the ${t.nounPlural} per person of ${other} (${tally}).`;
      return `Same clients, same months, a ${t.noun} from ${winner.label} costs ${x2(l.cost.ratio)} one from ${other} (95% interval ${x2(l.cost.lo)} to ${x2(l.cost.hi)}; ${x2(l.rate.ratio)} the ${t.nounPlural} per person; ${tally}).`;
    });
}

const nouns = (t: PipeTerms) => ({ noun: t.noun, nouns: t.nounPlural });

export function judge(study: Omit<ResearchStudy, "verdict"> & { verdict?: Verdict }, v: Verdict): ResearchStudy {
  const out = { ...study, verdict: { kind: v.kind, reason: v.reason }, crowned: v.kind === "conclusion" } as ResearchStudy;
  if (out.status === "measured") out.headline = headlineFor(out.headline, v.kind);
  return out;
}

export interface DimensionSpec {
  /** The study's topic, also its id part (`<pipe>-<topic>-roi`). */
  topic: ResearchTopic;
  dimNoun: string;
  /** Bars carry their key (a page opens per workflow, template, model). */
  keyed: boolean;
  /** Add the same-clients lines under the winner (the LLM studies). */
  likeForLikeLines?: boolean;
  /** Lines added under every study of the dimension (who was left out and why). */
  extraLines?: string[];
}

/** The ROI study and the rate study of one dimension of one pipe. */
export function dimensionStudies(t: PipeTerms, rows: readonly ResearchBucket[], spec: DimensionSpec): ResearchStudy[] {
  const strata = strataOf(rows);
  const out: ResearchStudy[] = [];
  // ROI
  {
    const w = pricedSorted(rows)[0];
    const line = w?.months ? monthLine(t, w.months, "cost") : [];
    const moved = movement(line);
    const base = {
      id: `${t.pipe}-${spec.topic}-roi`,
      pipe: t.pipe,
      topic: spec.topic,
      goal: "roi" as const,
      question: `Which ${spec.dimNoun} gets the cheapest ${t.noun}?`,
      status: w ? ("measured" as const) : ("not_enough_data" as const),
      headline: !w ? `No ${spec.dimNoun} has produced a ${t.noun} yet.` : `${w.label} wins at ${usd(costOf(w.figures)!)} per ${t.noun}.`,
      winner: w ? w.label : null,
      result: w ? { display: usd(costOf(w.figures)!), unit: `per ${t.noun}`, sample: counts(t, w.figures) } : null,
      crowned: false,
      charts: [
        { kind: "bars" as const, title: costTitle(t), lowerIsBetter: true, points: costBars(t, rows, { keyed: spec.keyed }), note: t.note },
        ...(w?.months && line.length ? [monthsChart(t, w.months, "cost", w.label)] : []),
      ],
      conclusion: [
        w ? `${w.label}: ${counts(t, w.figures)}, ${usd(w.figures.spentUsd)} spent.` : `Nothing priced yet.`,
        ...(moved ? [`Over time: ${moved}.`] : []),
        ...(w && spec.likeForLikeLines ? likeForLikeLines(t, rows, w, "roi") : []),
        ...(spec.extraLines ?? []),
      ],
    };
    const { a, b, m } = pairOf(rows, "roi");
    out.push(base.status === "measured" ? judge(base, compareVerdict({ a: arm(a), b: arm(b), goal: "roi", comparisons: m, strata, ...nouns(t) })) : judge(base, noiseOf(base.conclusion)));
  }
  // rate
  {
    const w = drawnSorted(rows).find((r) => r.figures.outcomes > 0);
    const line = w?.months ? monthLine(t, w.months, "rate") : [];
    const moved = movement(line);
    const rate = w ? rateOf(w.figures)! : 0;
    const base = {
      id: `${t.pipe}-${spec.topic}-rate`,
      pipe: t.pipe,
      topic: spec.topic,
      goal: "rate" as const,
      question: `Which ${spec.dimNoun} gets the most ${t.nounPlural}?`,
      status: w ? ("measured" as const) : ("not_enough_data" as const),
      headline: !w ? `No ${spec.dimNoun} has earned a ${t.noun} yet.` : `${w.label} wins with ${rateSentence(t, rate)}.`,
      winner: w ? w.label : null,
      result: w ? { display: pctText(rate), unit: rateLabel(t), sample: counts(t, w.figures) } : null,
      crowned: false,
      charts: [
        { kind: "bars" as const, title: rateTitle(t), lowerIsBetter: false, points: rateBars(t, rows, { keyed: spec.keyed }), note: t.note },
        ...(w?.months && line.length ? [monthsChart(t, w.months, "rate", w.label)] : []),
      ],
      conclusion: [
        ...(w ? [`${w.label}: ${counts(t, w.figures)}.`] : []),
        ...(moved ? [`Over time: ${moved}.`] : []),
        ...(w && spec.likeForLikeLines ? likeForLikeLines(t, rows, w, "rate") : []),
        `A ${spec.dimNoun} short of the maturity rule is ranked where its value puts it and marked Learning.`,
        ...(spec.extraLines ?? []),
      ],
    };
    const { a, b, m } = pairOf(rows, "rate");
    out.push(base.status === "measured" ? judge(base, compareVerdict({ a: arm(a), b: arm(b), goal: "rate", comparisons: m, strata, ...nouns(t) })) : judge(base, noiseOf(base.conclusion)));
  }
  return out;
}

const noiseOf = (lines: readonly string[]): Verdict => ({ kind: "noise", reason: lines[0] ?? "Not enough data yet." });

/** What an outcome costs on average since inception, the whole pipe (all buckets pooled). */
export function costOverTimeStudy(t: PipeTerms, months: readonly BucketMonth[] | null, total: BucketFigures, extraHeadline = ""): ResearchStudy {
  const avg = total.outcomes > 0 && total.spentUsd > 0 ? total.spentUsd / total.outcomes : null;
  const base = {
    id: `${t.pipe}-cost-over-time`,
    pipe: t.pipe,
    topic: "cost" as const,
    goal: "roi" as const,
    question: `What does a ${t.noun} cost on average?`,
    status: avg !== null ? ("measured" as const) : ("not_enough_data" as const),
    headline: avg !== null ? `${usd(avg)} per ${t.noun} on average since inception, across all our emails${extraHeadline}.` : `Not enough ${t.nounPlural} to state an average yet.`,
    winner: null,
    result: avg !== null ? { display: usd(avg), unit: `per ${t.noun}, average since inception`, sample: `${counts(t, total)} · ${usd(total.spentUsd)} spent` } : null,
    crowned: false,
    charts: months && months.length ? [monthsChart(t, months, "cost", "All our emails")] : [],
    conclusion: [`The average divides everything spent since the first email by every ${t.noun} since; the monthly bars are context, not the answer.`],
  };
  if (avg === null) return judge(base, noiseOf(base.conclusion));
  const [lo, hi] = poissonInterval(total.outcomes);
  return judge(
    base,
    total.outcomes >= MIN_OUTCOMES
      ? { kind: "conclusion", reason: `A measurement on ${n(total.outcomes)} ${t.nounPlural}: 95% interval ${usd(total.spentUsd / hi)} to ${usd(total.spentUsd / lo)} per ${t.noun}.` }
      : { kind: "noise", reason: `Only ${n(total.outcomes)} ${total.outcomes === 1 ? t.noun : t.nounPlural} so far.` },
  );
}

/** A study this pipe cannot answer, stated (never left out of the page). */
export function notMeasuredStudy(input: {
  id: string;
  pipe: ResearchPipeId | null;
  outcome?: "meeting" | "judgment";
  topic: ResearchTopic;
  goal: ResearchGoal;
  question: string;
  headline: string;
  reason: string;
}): ResearchStudy {
  return {
    id: input.id,
    pipe: input.pipe,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    topic: input.topic,
    goal: input.goal,
    question: input.question,
    status: "not_enough_data",
    headline: input.headline,
    winner: null,
    crowned: false,
    verdict: { kind: "noise", reason: input.reason },
    result: null,
    charts: [],
    conclusion: [input.reason],
  };
}

/** Sum figures. */
export function sumFigures(rows: Iterable<BucketFigures>): BucketFigures {
  const t = { spentUsd: 0, contacted: 0, outcomes: 0 };
  for (const r of rows) {
    t.spentUsd += r.spentUsd;
    t.contacted += r.contacted;
    t.outcomes += r.outcomes;
  }
  return t;
}

/** "Sep 27" for a `YYYY-MM-DD` cutoff. */
export const cutoffText = (ymd: string): string => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;
