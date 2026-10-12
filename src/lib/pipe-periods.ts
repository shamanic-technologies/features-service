/**
 * A PIPE'S FIGURES BY CALENDAR PERIOD (owner 2026-10-12, PIPE-PERIODS-1012: "retranscris-le dans la page du pipe de leur
 * team, mais aussi dans Auk ... évidemment pour les stats de ce pipe"). The table the owner drew by hand:
 *
 *   | Period         | Meta form leads | Meetings booked | Rate |
 *   | Since Dec 2024 | 306             | 189             | 62%  |
 *   | Q1 2026        | 82              | 61              | 74%  |
 *
 * ONE builder for every pipe (`stats.periods`) and for the "your team alone vs your team + this pipe" table
 * (`stats.teamImpact.periods`): the SAME dated counts the daily history cumulates, summed per UTC calendar month and per
 * calendar quarter, NOT cumulative, plus a since-inception total row. A COHORT where the producer allows it (the owner's
 * table: "Q1 2026: 82 form leads, 61 of THEM booked"): a later count is filed on the day the person entered the pipe's
 * INPUT (`countsDatedBy: input_day`: entry pipes by the serve, internal pipes by the hand-over, our leads / team impact by
 * the day they reached `from`), so a period reads `to ⊆ from` and its rate stays ≤ 100%. A count the producer can only
 * date by its own event (`own_date`) is filed there (it can read above the period's input). An UNDATED count sits in no period and
 * enters the total row only (`undated` states how many). Rate null with no input in the period (never 0 for "nobody
 * came"; a measured 0 outcome over a real input IS 0). Spend/cost per outcome only where the pipe has spend of ours
 * (`spend: null` = customer time, both null). Periods run from the first dated count or spend to today's, every
 * period listed (an empty one reads 0), oldest first.
 */

export interface DatedCounts {
  daily: ReadonlyMap<string, number>;
  undated: number;
}

export interface PeriodRatePair {
  key: string;
  fromKey: string;
  toKey: string;
}

export type PeriodRateUnavailableReason = "no_input_yet" | "volume_not_measured";

export interface PipePeriodRow {
  /** `2026-Q1`, `2026-10`, or `since_inception`. */
  period: string;
  kind: "month" | "quarter" | "since_inception";
  /** Display label, printable as is: `Q1 2026`, `Oct 2026`, `Since Dec 2024`. */
  label: string;
  /** First and last UTC day of the period (the total row: first activity day -> today; null with no dated activity). */
  startDate: string | null;
  endDate: string;
  /** count key -> count filed in the period (null = unmeasured). The total row adds the undated counts. */
  counts: Record<string, number | null>;
  /** rate key -> to ÷ from × 100 in the period, PERCENT, 2 decimals. */
  ratesPct: Record<string, number | null>;
  rateUnavailableReasons: Record<string, PeriodRateUnavailableReason | null>;
  /** NET spend of ours in the period; null when the figure has no spend of ours (customer time). */
  spendUsd: number | null;
  /** spendUsd ÷ the outcome count in the period; null with no outcome, no spend, or no spend of ours. */
  costPerOutcomeUsd: number | null;
}

export interface PipePeriods {
  basis: "calendar_period";
  /** count key -> the date it is filed on: `input_day` (cohort: the day the person entered the pipe's input) or
   *  `own_date` (its own event's day). */
  countsDatedBy: Record<string, "input_day" | "own_date">;
  /** The total row: every count since inception, dated + undated (equals the snapshot). */
  total: PipePeriodRow;
  /** Calendar quarters, oldest first. */
  quarters: PipePeriodRow[];
  /** Calendar months, oldest first. */
  months: PipePeriodRow[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const monthOf = (day: string): string => day.slice(0, 7);
const quarterOf = (day: string): string => `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
const monthLabel = (month: string): string => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const quarterLabel = (q: string): string => `${q.slice(5)} ${q.slice(0, 4)}`;

function lastDayOfMonth(year: number, month1: number): string {
  return new Date(Date.UTC(year, month1, 0)).toISOString().slice(0, 10);
}

function monthBounds(month: string): { start: string; end: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return { start: `${month}-01`, end: lastDayOfMonth(y, m) };
}

function quarterBounds(q: string): { start: string; end: string } {
  const y = Number(q.slice(0, 4));
  const first = (Number(q.slice(6)) - 1) * 3 + 1;
  return { start: `${y}-${String(first).padStart(2, "0")}-01`, end: lastDayOfMonth(y, first + 2) };
}

function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  const endY = Number(last.slice(0, 4));
  const endM = Number(last.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function rate(to: number | null, from: number | null): { ratePct: number | null; reason: PeriodRateUnavailableReason | null } {
  if (to === null || from === null) return { ratePct: null, reason: "volume_not_measured" };
  if (from === 0) return { ratePct: null, reason: "no_input_yet" };
  return { ratePct: round2((to / from) * 100), reason: null };
}

/** PURE: the period table (see the header). `counts` null = unmeasured; `spendByDay` null = no spend of ours. */
export function buildPipePeriods(input: {
  counts: ReadonlyArray<{ key: string; counts: DatedCounts | null; datedBy: "input_day" | "own_date" }>;
  ratePairs: readonly PeriodRatePair[];
  /** The count spend is divided by (cost per outcome); null = no cost per outcome. */
  outcomeKey: string | null;
  spendByDay: ReadonlyMap<string, number> | null;
  today: string;
}): PipePeriods {
  const dated = new Set<string>();
  for (const c of input.counts) for (const [d, n] of c.counts?.daily ?? []) if (n !== 0 && DAY_RE.test(d) && d <= input.today) dated.add(d);
  for (const [d, usd] of input.spendByDay ?? []) if (usd !== 0 && DAY_RE.test(d) && d <= input.today) dated.add(d);
  const first = dated.size > 0 ? [...dated].sort()[0]! : null;

  const row = (period: string, kind: PipePeriodRow["kind"], label: string, startDate: string | null, endDate: string, inPeriod: (day: string) => boolean, withUndated: boolean): PipePeriodRow => {
    const counts: Record<string, number | null> = {};
    for (const c of input.counts) {
      if (c.counts === null) {
        counts[c.key] = null;
        continue;
      }
      let n = withUndated ? c.counts.undated : 0;
      for (const [d, v] of c.counts.daily) if (DAY_RE.test(d) ? inPeriod(d) : withUndated) n += v;
      counts[c.key] = n;
    }
    const ratesPct: Record<string, number | null> = {};
    const rateUnavailableReasons: Record<string, PeriodRateUnavailableReason | null> = {};
    for (const p of input.ratePairs) {
      const r = rate(counts[p.toKey] ?? null, counts[p.fromKey] ?? null);
      ratesPct[p.key] = r.ratePct;
      rateUnavailableReasons[p.key] = r.reason;
    }
    let spendUsd: number | null = null;
    if (input.spendByDay !== null) {
      let s = 0;
      for (const [d, usd] of input.spendByDay) if (DAY_RE.test(d) && (inPeriod(d) || (withUndated && d > input.today))) s += usd;
      spendUsd = round2(s);
    }
    const outcomes = input.outcomeKey === null ? null : (counts[input.outcomeKey] ?? null);
    const costPerOutcomeUsd = spendUsd !== null && spendUsd > 0 && outcomes !== null && outcomes > 0 ? round2(spendUsd / outcomes) : null;
    return { period, kind, label, startDate, endDate, counts, ratesPct, rateUnavailableReasons, spendUsd, costPerOutcomeUsd };
  };

  const total = row("since_inception", "since_inception", first === null ? "Since inception" : `Since ${monthLabel(monthOf(first))}`, first, input.today, () => true, true);
  const countsDatedBy = Object.fromEntries(input.counts.map((c) => [c.key, c.datedBy]));
  if (first === null) return { basis: "calendar_period", countsDatedBy, total, quarters: [], months: [] };

  const months = monthsBetween(monthOf(first), monthOf(input.today));
  const quarters = [...new Set(months.map((m) => quarterOf(`${m}-01`)))];
  return {
    basis: "calendar_period",
    countsDatedBy,
    total,
    quarters: quarters.map((q) => {
      const b = quarterBounds(q);
      return row(q, "quarter", quarterLabel(q), b.start, b.end, (d) => quarterOf(d) === q, false);
    }),
    months: months.map((m) => {
      const b = monthBounds(m);
      return row(m, "month", monthLabel(m), b.start, b.end, (d) => monthOf(d) === m, false);
    }),
  };
}
