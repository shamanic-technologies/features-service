/**
 * "YOUR TEAM ALONE vs YOUR TEAM + THIS PIPE" ON A PLATFORM PIPE (owner 2026-10-12: "dans cette page Pipe, qui possède un
 * co-leg avec un channel YOUR TEAM, il faut toujours dans ce cas comparer sur un tableau les stats YOUR TEAM alone, avec
 * YOUR TEAM et this PIPE being ON, pour voir l'impact relatif de cette pipe"; "on peut supposer que your team est
 * toujours ON").
 *
 * ONE rule for every PLATFORM pipe whose leg (same `from`, same `to`) also has a customer-team pipe, never a per-channel
 * branch. Both rows are measured on the people OUR campaigns brought to the leg's `from` step (`lib/team-on-our-leads.ts`,
 * the same read as the customer-team pipe's `ourLeadsToTeam`), each counted once from the day they reached `from`:
 *   - TEAM ALONE: those none of our pipes on the leg acted on (= the customer-team pipe's `ourLeadsToTeam`), and how many
 *     reached `to` on or after that day. No spend of ours: cost per outcome null (`customer_team_time`);
 *   - TEAM + THIS PIPE: those THIS pipe's campaigns in scope acted on (their team is assumed still on), and how many
 *     reached `to` under the same rule; cost per outcome = this pipe's NET spend in scope ÷ those outcomes (the pipe's
 *     own cost basis, `lib/pipe-stats.ts`);
 *   - IMPACT: team + pipe rate − team alone rate, in POINTS, and their RATIO. Null + reason when a side is unmeasured or
 *     has nobody at `from` (the ratio also when the team-alone rate is 0), never 0 for "not measured".
 * HISTORY: one cumulative point per UTC day from the first dated count or spend to today; undated counts (and spend
 * dated after today) enter on the last point, so the last point IS the snapshot.
 * A pipe with no customer-team co-leg serves null (nothing new).
 */
import type { DatedCount, OurLeadsToTeamReason } from "./team-on-our-leads.js";
import { buildPipePeriods, type PipePeriods } from "./pipe-periods.js";

export type ImpactRowUnavailableReason = OurLeadsToTeamReason | "no_input_yet";
export type ImpactUnavailableReason =
  | "team_alone_not_measured"
  | "team_alone_no_input"
  | "team_plus_pipe_not_measured"
  | "team_plus_pipe_no_input"
  | "team_alone_rate_zero";

export interface PipeTeamImpactRow {
  key: "team_alone" | "team_plus_pipe";
  label: string;
  /** People at the `from` step in this row (null = unmeasured). */
  fromCount: number | null;
  /** Of them, reached `to` on or after the day they reached `from`. */
  toCount: number | null;
  /** Of the counts above, how many sit in no day (they enter the history's last point only). */
  undatedFrom: number;
  undatedTo: number;
  /** toCount ÷ fromCount × 100, 2 decimals. */
  ratePct: number | null;
  rateUnavailableReason: ImpactRowUnavailableReason | "volume_not_measured" | null;
  /** NET spend of ours on this row (team alone: null, the customer's time). */
  spendUsd: number | null;
  costPerOutcomeUsd: number | null;
  costPerOutcomeUnavailableReason: "customer_team_time" | "no_outcome_yet" | "outcome_not_measured" | "no_spend_recorded" | null;
}

export interface PipeTeamImpactFigure {
  /** team + pipe rate − team alone rate, percentage POINTS, 2 decimals. */
  pointsDiff: number | null;
  pointsDiffUnavailableReason: Exclude<ImpactUnavailableReason, "team_alone_rate_zero"> | null;
  /** team + pipe rate ÷ team alone rate, 2 decimals. */
  ratio: number | null;
  ratioUnavailableReason: ImpactUnavailableReason | null;
}

export interface PipeTeamImpactPoint {
  date: string;
  teamAlone: { fromCount: number | null; toCount: number | null; ratePct: number | null };
  teamPlusPipe: { fromCount: number | null; toCount: number | null; ratePct: number | null; spendUsd: number; costPerOutcomeUsd: number | null };
  impact: { pointsDiff: number | null; ratio: number | null };
}

export interface PipeTeamImpact {
  population: "people_our_campaigns_brought_to_from";
  /** The customer-team channel slugs sharing this pipe's leg. */
  teamChannelSlugs: string[];
  /** Column labels: the leg's own steps (never a unit borrowed from one pipe). */
  fromStepLabel: string | null;
  toStepLabel: string;
  available: boolean;
  unavailableReason: OurLeadsToTeamReason | null;
  rows: [PipeTeamImpactRow, PipeTeamImpactRow];
  impact: PipeTeamImpactFigure;
  firstActivityDay: string | null;
  history: PipeTeamImpactPoint[];
  /** Both rows by calendar month and quarter, not cumulative, plus a since-inception row (`lib/pipe-periods.ts`):
   *  counts `teamAloneFrom`/`teamAloneTo`/`teamPlusPipeFrom`/`teamPlusPipeTo`, rates `teamAlone`/`teamPlusPipe`, spend and
   *  cost per outcome = this pipe's (team + pipe row), `impactPointsDiff` per period. */
  periods: PipePeriods & { impactPointsDiff: Record<string, number | null> };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const nextDay = (day: string): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const total = (v: DatedCount | null): number | null => (v === null ? null : [...v.daily.values()].reduce((a, b) => a + b, 0) + v.undated);
/** Unrounded rate (null with no population). */
const rawRate = (to: number | null, from: number | null): number | null => (to === null || from === null || from === 0 ? null : (to / from) * 100);

/** PURE: points and ratio of two unrounded rates, with the reason each is null. */
export function impactOf(teamFrom: number | null, teamRate: number | null, pipeFrom: number | null, pipeRate: number | null): PipeTeamImpactFigure {
  let reason: PipeTeamImpactFigure["pointsDiffUnavailableReason"] = null;
  if (teamFrom === null) reason = "team_alone_not_measured";
  else if (pipeFrom === null) reason = "team_plus_pipe_not_measured";
  else if (teamFrom === 0) reason = "team_alone_no_input";
  else if (pipeFrom === 0) reason = "team_plus_pipe_no_input";
  if (reason !== null || teamRate === null || pipeRate === null) {
    return { pointsDiff: null, pointsDiffUnavailableReason: reason, ratio: null, ratioUnavailableReason: reason };
  }
  return {
    pointsDiff: round2(pipeRate - teamRate),
    pointsDiffUnavailableReason: null,
    ratio: teamRate === 0 ? null : round2(pipeRate / teamRate),
    ratioUnavailableReason: teamRate === 0 ? "team_alone_rate_zero" : null,
  };
}

/** PURE: the served block (see the header). `team`/`pipe` null = unmeasured (`reason` says why). */
export function buildPipeTeamImpact(input: {
  teamChannelSlugs: readonly string[];
  fromStepLabel: string | null;
  toStepLabel: string;
  reason: OurLeadsToTeamReason | null;
  team: { from: DatedCount; to: DatedCount } | null;
  pipe: { from: DatedCount; to: DatedCount } | null;
  /** This pipe's NET spend per UTC day in scope. */
  spendByDay: ReadonlyMap<string, number>;
  today: string;
}): PipeTeamImpact {
  const measured = input.reason === null && input.team !== null && input.pipe !== null;
  const team = measured ? input.team : null;
  const pipe = measured ? input.pipe : null;

  const days = new Set<string>();
  for (const v of [team?.from, team?.to, pipe?.from, pipe?.to]) for (const [d, n] of v?.daily ?? []) if (n !== 0 && DAY_RE.test(d)) days.add(d);
  for (const [d, usd] of input.spendByDay) if (usd !== 0 && DAY_RE.test(d)) days.add(d);
  const first = days.size > 0 ? [...days].sort()[0]! : null;
  const anyUndated = [team?.from, team?.to, pipe?.from, pipe?.to].some((v) => (v?.undated ?? 0) > 0);

  const history: PipeTeamImpactPoint[] = [];
  const cum = { tf: 0, tt: 0, pf: 0, pt: 0 };
  let spend = 0;
  if (first !== null || anyUndated) {
    const start = first !== null && first <= input.today ? first : input.today;
    for (let day = start; day <= input.today; day = nextDay(day)) {
      const last = day === input.today;
      spend += input.spendByDay.get(day) ?? 0;
      if (last) for (const [d, usd] of input.spendByDay) if (DAY_RE.test(d) && d > input.today) spend += usd;
      const step = (k: keyof typeof cum, v: DatedCount | undefined): number | null => {
        if (!v) return null;
        cum[k] += v.daily.get(day) ?? 0;
        return last ? cum[k] + v.undated : cum[k];
      };
      const tf = step("tf", team?.from);
      const tt = step("tt", team?.to);
      const pf = step("pf", pipe?.from);
      const pt = step("pt", pipe?.to);
      const tr = rawRate(tt, tf);
      const pr = rawRate(pt, pf);
      const imp = impactOf(tf, tr, pf, pr);
      history.push({
        date: day,
        teamAlone: { fromCount: tf, toCount: tt, ratePct: tr === null ? null : round2(tr) },
        teamPlusPipe: { fromCount: pf, toCount: pt, ratePct: pr === null ? null : round2(pr), spendUsd: round2(spend), costPerOutcomeUsd: pt !== null && pt > 0 && spend > 0 ? round2(spend / pt) : null },
        impact: { pointsDiff: imp.pointsDiff, ratio: imp.ratio },
      });
    }
  } else {
    for (const [d, usd] of input.spendByDay) if (DAY_RE.test(d)) spend += usd;
  }

  const tf = total(team?.from ?? null);
  const tt = total(team?.to ?? null);
  const pf = total(pipe?.from ?? null);
  const pt = total(pipe?.to ?? null);
  const rowRate = (to: number | null, from: number | null, unmeasured: OurLeadsToTeamReason | "volume_not_measured") => {
    if (to === null || from === null) return { ratePct: null, rateUnavailableReason: unmeasured };
    if (from === 0) return { ratePct: null, rateUnavailableReason: "no_input_yet" as const };
    return { ratePct: round2((to / from) * 100), rateUnavailableReason: null };
  };
  const unmeasured = input.reason ?? "volume_not_measured";
  let costReason: PipeTeamImpactRow["costPerOutcomeUnavailableReason"] = null;
  if (pt === null) costReason = "outcome_not_measured";
  else if (pt === 0) costReason = "no_outcome_yet";
  else if (spend <= 0) costReason = "no_spend_recorded";
  return {
    population: "people_our_campaigns_brought_to_from",
    teamChannelSlugs: [...input.teamChannelSlugs].sort(),
    fromStepLabel: input.fromStepLabel,
    toStepLabel: input.toStepLabel,
    available: measured,
    unavailableReason: measured ? null : (input.reason ?? null),
    rows: [
      {
        key: "team_alone",
        label: "Your team alone",
        fromCount: tf,
        toCount: tt,
        undatedFrom: team?.from.undated ?? 0,
        undatedTo: team?.to.undated ?? 0,
        ...rowRate(tt, tf, unmeasured),
        spendUsd: null,
        costPerOutcomeUsd: null,
        costPerOutcomeUnavailableReason: "customer_team_time",
      },
      {
        key: "team_plus_pipe",
        label: "Your team + this pipe",
        fromCount: pf,
        toCount: pt,
        undatedFrom: pipe?.from.undated ?? 0,
        undatedTo: pipe?.to.undated ?? 0,
        ...rowRate(pt, pf, unmeasured),
        spendUsd: round2(spend),
        costPerOutcomeUsd: costReason === null ? round2(spend / pt!) : null,
        costPerOutcomeUnavailableReason: costReason,
      },
    ],
    impact: impactOf(tf, rawRate(tt, tf), pf, rawRate(pt, pf)),
    firstActivityDay: first,
    history,
    periods: teamImpactPeriods(team, pipe, input.spendByDay, input.today),
  };
}

/** PURE: the two rows by calendar period, and the points between their rates per period (null when either is). */
function teamImpactPeriods(
  team: { from: DatedCount; to: DatedCount } | null,
  pipe: { from: DatedCount; to: DatedCount } | null,
  spendByDay: ReadonlyMap<string, number>,
  today: string,
): PipeTeamImpact["periods"] {
  const periods = buildPipePeriods({
    counts: [
      { key: "teamAloneFrom", counts: team?.from ?? null },
      { key: "teamAloneTo", counts: team?.to ?? null },
      { key: "teamPlusPipeFrom", counts: pipe?.from ?? null },
      { key: "teamPlusPipeTo", counts: pipe?.to ?? null },
    ],
    ratePairs: [
      { key: "teamAlone", fromKey: "teamAloneFrom", toKey: "teamAloneTo" },
      { key: "teamPlusPipe", fromKey: "teamPlusPipeFrom", toKey: "teamPlusPipeTo" },
    ],
    outcomeKey: "teamPlusPipeTo",
    spendByDay,
    today,
  });
  const impactPointsDiff: Record<string, number | null> = {};
  for (const r of [periods.total, ...periods.quarters, ...periods.months]) {
    const a = r.ratesPct.teamAlone;
    const b = r.ratesPct.teamPlusPipe;
    impactPointsDiff[r.period] = a === null || b === null ? null : round2(b - a);
  }
  return { ...periods, impactPointsDiff };
}

/** PURE: sum per-brand dated counts. */
export function sumDated(counts: ReadonlyArray<DatedCount>): DatedCount {
  const daily = new Map<string, number>();
  let undated = 0;
  for (const v of counts) {
    for (const [d, n] of v.daily) daily.set(d, (daily.get(d) ?? 0) + n);
    undated += v.undated;
  }
  return { daily, undated };
}
