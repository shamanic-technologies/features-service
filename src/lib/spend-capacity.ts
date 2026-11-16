/**
 * PROJECTION-CAP-1117 (prod 2026-11-17, Wide Email: its monthly cap reached, $219.98 of $220, while its milestones served
 * « Next Lead found in about 2 hours »): a projection reads the campaign's REAL capacity to spend, one rule for every campaign
 * and outcome. A stopped campaign expects nothing; a budget cap spends at most what remains in its window, then nothing until
 * the window resets, then the full amount again; a volume cap reached expects nothing until its window resets. A one-off cap
 * reached never resets. PURE; the caps read is `funnel-campaign-budget-client.ts`.
 *
 * The output is an EXPECTED SCHEDULE: the Target outcomes expected in what is left of today (segment 0), then in each
 * following UTC day, far enough to find the next one of a slow outcome. Merging campaigns sums schedules; a milestone scales
 * its Target's schedule by its outcomes needed per Target.
 */

export type CapPeriod = "daily" | "weekly" | "monthly" | "one_off";

/** What billing serves about the campaign's caps NOW (its own, else the funnel-wide one it is held to). */
export interface SpendCapacityInput {
  /** campaign-service status: anything but `ongoing` spends nothing. */
  campaignStatus: string;
  /** null = no max budget stated. */
  budget: {
    period: CapPeriod;
    amountUsd: number;
    /** Exclusive end of the current window (UTC midnight); null on one_off. */
    periodEnd: string | null;
    /** What is left in the current window; null = consumption unreadable. */
    remainingUsd: number | null;
    /** billing's verdict (a refused spend in the window = reached). null = unreadable. */
    reached: boolean | null;
  } | null;
  /** null = no max volume stated, or not reached. */
  volumeReached: { periodEnd: string | null } | null;
  /** The caps read failed: no projection can say what the campaign can spend. */
  unreadableReason: string | null;
}

/** Why the projection expects nothing, for good (served as `unavailableReason`). */
export type CapacityUnavailableReason =
  | "campaign_stopped"
  | "budget_cap_spent_no_reset"
  | "volume_cap_reached_no_reset"
  | "budget_consumption_unreadable"
  | "spend_capacity_unreadable";

/** Why the projection expects nothing NOW, until `resumesAt` (served as `pausedReason`). */
export type CapacityPausedReason = "budget_cap_reached" | "volume_cap_reached";

export interface ExpectedSchedule {
  /** Hours left in today (segment 0). */
  todayHours: number;
  /** Expected Target outcomes per segment: [rest of today, day +1, day +2, ...]. */
  outcomes: number[];
  /** The full pace (outcomes per day while the campaign spends). */
  outcomesPerDayWhenSpending: number;
  pausedReason: CapacityPausedReason | null;
  resumesAt: string | null;
}

const DAY_MS = 86_400_000;
/** How far a schedule reaches: far enough for a Paid client every few months, bounded. */
export const SCHEDULE_DAYS = 3 * 365;

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The end of the window following one ending at `end` (billing `periodWindow`: UTC midnight, Monday weeks, calendar months). */
function nextWindowEnd(end: number, period: Exclude<CapPeriod, "one_off">): number {
  if (period === "daily") return end + DAY_MS;
  if (period === "weekly") return end + 7 * DAY_MS;
  const d = new Date(end);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** PURE: the capacity verdict that holds for good (nothing expected), else null. */
export function capacityUnavailableReason(c: SpendCapacityInput): CapacityUnavailableReason | null {
  if (c.campaignStatus !== "ongoing") return "campaign_stopped";
  if (c.unreadableReason !== null) return "spend_capacity_unreadable";
  if (c.budget !== null) {
    if (c.budget.reached === null && c.budget.remainingUsd === null) return "budget_consumption_unreadable";
    if (c.budget.periodEnd === null && (c.budget.reached === true || c.budget.remainingUsd === 0)) return "budget_cap_spent_no_reset";
  }
  if (c.volumeReached !== null && c.volumeReached.periodEnd === null) return "volume_cap_reached_no_reset";
  return null;
}

/**
 * PURE: the schedule of a campaign spending `spendPerDayUsd` at `outcomesPerDay` (full pace) under its capacity. The caller
 * has already checked `capacityUnavailableReason` is null. Spend is spread evenly over a day; a budget window's remaining
 * caps a day's spend, and resets to the cap's amount at the window's end.
 */
export function expectedScheduleOf(outcomesPerDay: number, spendPerDayUsd: number, c: SpendCapacityInput, now: string): ExpectedSchedule {
  const nowMs = Date.parse(now);
  const tomorrow = Date.parse(`${addDays(now.slice(0, 10), 1)}T00:00:00.000Z`);
  const todayHours = (tomorrow - nowMs) / 3_600_000;
  const budget = c.budget;
  let remaining = budget === null ? Infinity : budget.reached === true ? 0 : budget.remainingUsd ?? Infinity;
  let windowEnd = budget?.periodEnd ? Date.parse(budget.periodEnd) : Infinity;
  const volumeUntil = c.volumeReached?.periodEnd ? Date.parse(c.volumeReached.periodEnd) : -Infinity;
  const outcomes: number[] = [];
  for (let k = 0; k <= SCHEDULE_DAYS; k += 1) {
    const start = k === 0 ? nowMs : tomorrow + (k - 1) * DAY_MS;
    const hours = k === 0 ? todayHours : 24;
    if (budget !== null && budget.period !== "one_off" && start >= windowEnd) {
      remaining = budget.amountUsd;
      windowEnd = nextWindowEnd(windowEnd, budget.period);
    }
    if (start < volumeUntil) {
      outcomes.push(0);
      continue;
    }
    const full = (spendPerDayUsd * hours) / 24;
    const spend = Math.min(full, remaining);
    remaining -= spend;
    outcomes.push(full > 0 ? (outcomesPerDay * hours * spend) / (24 * full) : 0);
  }
  // Paused NOW = nothing spendable in what is left of today; resumes at the first segment expecting something.
  const pausedReason: CapacityPausedReason | null =
    outcomes[0]! > 0 ? null : nowMs < volumeUntil ? "volume_cap_reached" : budget !== null ? "budget_cap_reached" : null;
  const firstAgain = outcomes.findIndex((o) => o > 0);
  const resumesAt = pausedReason === null || firstAgain < 0 ? null : new Date(tomorrow + (firstAgain - 1) * DAY_MS).toISOString();
  return { todayHours, outcomes, outcomesPerDayWhenSpending: outcomesPerDay, pausedReason, resumesAt };
}

/** PURE: a campaign with no cap at all (or a merged sum built elsewhere). */
export function unconstrainedSchedule(outcomesPerDay: number, now: string): ExpectedSchedule {
  return expectedScheduleOf(outcomesPerDay, 1, { campaignStatus: "ongoing", budget: null, volumeReached: null, unreadableReason: null }, now);
}

/** PURE: Σ of several schedules (same `now`), the merged entry of campaigns on one Target. */
export function sumSchedules(schedules: readonly ExpectedSchedule[]): ExpectedSchedule | null {
  if (schedules.length === 0) return null;
  const first = schedules[0]!;
  const outcomes = first.outcomes.map((_, k) => schedules.reduce((a, s) => a + (s.outcomes[k] ?? 0), 0));
  // Paused only when EVERY campaign is; then it resumes with the first one to (its reason).
  const paused = schedules.every((s) => s.pausedReason !== null);
  const firstBack = [...schedules].sort((x, y) => (x.resumesAt ?? "\uffff").localeCompare(y.resumesAt ?? "\uffff"))[0]!;
  return {
    todayHours: first.todayHours,
    outcomes,
    outcomesPerDayWhenSpending: schedules.reduce((a, s) => a + s.outcomesPerDayWhenSpending, 0),
    pausedReason: paused ? firstBack.pausedReason : null,
    resumesAt: paused ? firstBack.resumesAt : null,
  };
}

/** PURE: a schedule scaled (a milestone = its Target's schedule × its outcomes needed per Target). */
export function scaleSchedule(s: ExpectedSchedule, factor: number): ExpectedSchedule {
  return { ...s, outcomes: s.outcomes.map((o) => o * factor), outcomesPerDayWhenSpending: s.outcomesPerDayWhenSpending * factor };
}

/**
 * PURE: the served projection of a schedule: the next `days` UTC days (expected that day + the cumulative from today's
 * count) and when the next one is due (expected outcomes summed from now until one is reached; past the schedule's reach,
 * at the average pace of its last year, which holds for every periodic cap).
 */
export function projectSchedule(s: ExpectedSchedule | null, outcomesToDate: number | null, now: string, days: number) {
  const today = now.slice(0, 10);
  const daily: Array<{ date: string; expectedOutcomes: number; cumulativeExpectedOutcomes: number }> = [];
  if (s === null) return { daily, nextExpectedAt: null as string | null, nextExpectedInHours: null as number | null };
  let cumulative = outcomesToDate ?? 0;
  for (let k = 1; k <= days; k += 1) {
    const o = s.outcomes[k] ?? 0;
    cumulative += o;
    daily.push({ date: addDays(today, k), expectedOutcomes: round(o, 4), cumulativeExpectedOutcomes: round(cumulative, 2) });
  }
  let acc = 0;
  let hours = 0;
  let next: number | null = null;
  for (let k = 0; k < s.outcomes.length; k += 1) {
    const len = k === 0 ? s.todayHours : 24;
    const o = s.outcomes[k]!;
    if (acc + o >= 1 && o > 0) {
      next = hours + ((1 - acc) / o) * len;
      break;
    }
    acc += o;
    hours += len;
  }
  if (next === null) {
    const lastYear = s.outcomes.slice(-365);
    const perHour = lastYear.reduce((a, o) => a + o, 0) / (lastYear.length * 24);
    if (perHour > 0) next = hours + (1 - acc) / perHour;
  }
  const nextExpectedInHours = next !== null ? round(next, 2) : null;
  const nextExpectedAt = nextExpectedInHours !== null ? new Date(Date.parse(now) + nextExpectedInHours * 3_600_000).toISOString() : null;
  return { daily, nextExpectedAt, nextExpectedInHours };
}
