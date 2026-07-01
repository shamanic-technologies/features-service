/**
 * Pure assembly of the GLOBAL email send-forecast — `GET /public/stats/send-forecast`.
 *
 * Answers "how many outreach emails will the fleet send per calendar day over the next N days"
 * by STACKING three per-day series that are all in the SAME grain (one email = one unit):
 *
 *   1. actualSent   — PAST real emails sent per day (email-gateway `?groupBy=day` → broadcast
 *                     `emailStats.sent` = COUNT(email_sent events), follow-ups INCLUDED, bucketed
 *                     by real send timestamp). Cross-org, fleet-wide.
 *   2. inFlightSent — FUTURE follow-up sends already SCHEDULED for sequences launched BEFORE today
 *                     (instantly `sending-forecast` provisioned steps, relayed via email-gateway).
 *   3. forecastNew  — FUTURE emails from NEW sequences the active brands' daily budgets will launch
 *                     from today onward, each new sequence emitting on the D0/D3/D10 cadence model.
 *
 * Anti-double-count boundary: `forecastNew` covers cohorts STARTED today-or-later; `inFlightSent`
 * covers the follow-ups of cohorts started BEFORE today. They never overlap.
 *
 * `forecastNew` is a convolution: a cohort of `cohortSize(k)` NEW sequences started on day `k`
 * emits one email at `k`, one at `k+3`, one at `k+10`. So emails from new cohorts on day `d` =
 * Σ over the follow-up offsets `off` of `cohortSize(d − off)` (only for cohorts `d − off ≥ today`).
 * The fleet cohort size is constant `totalNewPerDay` (= Σ over active brands of budget/outreachUsd,
 * assuming budgets hold) EXCEPT today, whose cohort is scaled to the REMAINING budget
 * (`todayNewOverride` = Σ brand R·remaining/budget) since part of today's budget is already spent.
 *
 * Null-safe convention (mirrors the rest of the service): a day's forecast is `null` (renders "-")
 * when its inputs are absent, never a false 0.
 */

/** The email send cadence model: initial at D0, follow-ups at D+3 and D+10 (offsets from cohort start). */
export const FOLLOWUP_OFFSETS_DAYS = [0, 3, 10] as const;
export const FOLLOWUP_MODEL_LABEL = "D0/D3/D10";

/** Slug marker for the email-sequence outreach features that feed this forecast (instantly cold-email). */
const COLD_EMAIL_SLUG_SUFFIX = "-cold-email-outreach";

/** Keep only the feature slugs that send instantly cold-email sequences (the fleet the forecast models). */
export function coldEmailOutreachSlugs(allSlugs: readonly string[]): string[] {
  return allSlugs.filter((slug) => slug.endsWith(COLD_EMAIL_SLUG_SUFFIX));
}

export interface SendForecastDay {
  date: string;
  isToday: boolean;
  /** Past real emails sent that day (email-grain, follow-ups incl). null on future days. */
  actualSent: number | null;
  /** Already-scheduled follow-up sends for in-flight (pre-today) cohorts. null on past days. */
  inFlightSent: number | null;
  /** Projected emails from NEW (today-onward) budget-driven cohorts. null on past days. */
  forecastNew: number | null;
  /** Predictive total. Past: actualSent. Today+future: sum of the present components. */
  total: number | null;
}

export interface SendForecastSummary {
  totalDailyBudgetUsd: number;
  remainingTodayUsd: number;
  followupModel: string;
  activeBrandCount: number;
  /** Fleet new sequences/day at full budget (Σ brand budget/outreachUsd). */
  totalNewSequencesPerDay: number;
}

export interface BuildSendForecastInput {
  /** Contiguous UTC calendar dates, chronological, spanning the window (past tail → future horizon). */
  dates: string[];
  /** UTC "today" date string (must be one of `dates`). */
  todayIso: string;
  /** Fleet new sequences/day at full budget — the steady cohort size for every future day. */
  totalNewPerDay: number;
  /** Today's cohort size scaled to REMAINING budget (≤ totalNewPerDay). */
  todayNewOverride: number;
  /** Past real emails sent per day (email-grain), keyed by UTC date. */
  actualByDay: Map<string, number>;
  /** Scheduled in-flight follow-up sends per day, keyed by UTC date. */
  inFlightByDay: Map<string, number>;
  summary: Omit<SendForecastSummary, "followupModel">;
}

/**
 * Cohort size (new sequences started) on day `k`. Zero before today (those are the in-flight
 * series' responsibility), remaining-scaled today, full fleet rate after.
 */
function cohortSize(k: string, todayIso: string, totalNewPerDay: number, todayNewOverride: number): number {
  if (k < todayIso) return 0;
  if (k === todayIso) return todayNewOverride;
  return totalNewPerDay;
}

export function buildSendForecast(input: BuildSendForecastInput): {
  days: SendForecastDay[];
  summary: SendForecastSummary;
} {
  const { dates, todayIso, totalNewPerDay, todayNewOverride, actualByDay, inFlightByDay } = input;
  const dateSet = new Set(dates);

  const days: SendForecastDay[] = dates.map((date) => {
    const isToday = date === todayIso;
    const isPast = date < todayIso;

    // Past days: only the real sent series is meaningful.
    if (isPast) {
      const actualSent = actualByDay.get(date) ?? null;
      return { date, isToday: false, actualSent, inFlightSent: null, forecastNew: null, total: actualSent };
    }

    // Today + future: forecastNew = convolution of the cohort sizes over the follow-up offsets.
    let forecastNew = 0;
    for (const off of FOLLOWUP_OFFSETS_DAYS) {
      const startDate = addUtcDays(date, -off);
      // Only cohorts that fall inside the window's start-day range contribute; cohorts before today
      // contribute 0 by cohortSize(), cohorts before the window are unmodelled (still 0).
      if (startDate < todayIso) continue;
      if (!dateSet.has(startDate) && startDate > date) continue; // defensive; startDate ≤ date always
      forecastNew += cohortSize(startDate, todayIso, totalNewPerDay, todayNewOverride);
    }

    const inFlightSent = inFlightByDay.get(date) ?? null;

    // Today additionally carries the emails already sent so far today (disjoint from in-flight, which
    // is provisioned-not-yet-sent, and disjoint from forecastNew, which is the REMAINING new cohort).
    const actualSent = isToday ? (actualByDay.get(date) ?? null) : null;

    const total = sumNullable([actualSent, inFlightSent, forecastNew]);
    return { date, isToday, actualSent, inFlightSent, forecastNew, total };
  });

  return {
    days,
    summary: { ...input.summary, followupModel: FOLLOWUP_MODEL_LABEL },
  };
}

/** Sum of components treating null as "absent"; returns null only if EVERY component is null. */
function sumNullable(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` UTC date string, returning `YYYY-MM-DD`. */
export function addUtcDays(dateIso: string, deltaDays: number): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build a contiguous chronological list of UTC date strings from `startIso` through `endIso` inclusive. */
export function utcDateRange(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  let cursor = startIso;
  // Guard against inverted ranges / runaway loops (cap at ~2 years).
  for (let i = 0; i < 800 && cursor <= endIso; i++) {
    out.push(cursor);
    cursor = addUtcDays(cursor, 1);
  }
  return out;
}
