/**
 * Pure assembly of the GLOBAL email send-forecast — `GET /internal/stats/send-forecast`.
 *
 * Answers "how many outreach emails will the fleet SEND per calendar day over the next N days".
 *
 * The forecast is a QUEUE THAT DRAINS, not three independent per-day sums. Volume becomes DUE on a
 * day and is SENT on the first day the fleet has room for it — those are different dates, and the
 * whole point of this endpoint is the second one. Three email-grain series (one email = one unit):
 *
 *   1. actualSent   — PAST real emails sent per day (email-gateway `?groupBy=day` → broadcast
 *                     `emailStats.sent` = COUNT(email_sent events), follow-ups INCLUDED, bucketed
 *                     by real send timestamp). Cross-org, fleet-wide. Already happened, never drained.
 *   2. inFlightSent — sends drawn from the queue of follow-ups already PROVISIONED for sequences
 *                     launched BEFORE today (instantly `sending-forecast`, relayed by email-gateway).
 *   3. forecastNew  — sends drawn from the queue of NEW sequences the active brands' daily budgets
 *                     launch from today onward, on the D0/D3/D10 cadence model.
 *
 * TWO CONSTRAINTS the fleet is physically under, and both were missing before:
 *
 *   CAPACITY. The fleet can send at most `dailyCapacity` emails a day (the healthy mailbox count ×
 *   their per-mailbox limits — the provider already reports it on the same payload series 2 comes
 *   from). Anything due beyond that does NOT vanish and does NOT all land on one day: it stays in
 *   the queue and goes out on the next day with room.
 *
 *   SENDING DAYS. The fleet sends Monday-Friday (`SENDING_WEEKDAYS_UTC`). A weekend day has ZERO
 *   capacity, so nothing goes out and nothing is launched — the weekend's volume rolls to Monday.
 *
 * Priority within a day: the already-provisioned in-flight queue drains first (it is older work the
 * provider has already committed to), then whatever capacity is left launches new cohorts. A day
 * whose capacity is consumed by follow-ups therefore launches fewer new sequences, which is what
 * actually happens — the budget goes unspent rather than the emails going out anyway.
 *
 * `forecastNew`'s DUE stream is a convolution: a cohort of `cohortSize(k)` NEW sequences launched on
 * day `k` becomes due at `k`, `k+3`, `k+10`. Cohorts are launched ONLY on sending days, and only
 * today-or-later; today's is scaled to the REMAINING budget (`todayNewOverride`) since part of the
 * day's budget is already spent. Anti-double-count boundary: `forecastNew` covers cohorts started
 * today-or-later, `inFlightSent` covers the follow-ups of cohorts started before today.
 *
 * Volume is CONSERVED: over the horizon, everything due is either sent or still queued at the end.
 * Nothing is dropped by the capacity bound and nothing is counted twice.
 *
 * Null-safe convention (mirrors the rest of the service): a day's series is `null` (renders "-") when
 * it does not APPLY to that day, never a false 0. A past day has no forward series; a future day's
 * drained figure is a measured quantity and is reported even when it is 0 (the fleet really does send
 * nothing that day) — "we could not measure this" and "nothing goes out" are different statements.
 */

/** The email send cadence model: initial at D0, follow-ups at D+3 and D+10 (offsets from cohort start). */
export const FOLLOWUP_OFFSETS_DAYS = [0, 3, 10] as const;
export const FOLLOWUP_MODEL_LABEL = "D0/D3/D10";

/**
 * UTC weekdays the fleet sends on (0=Sun … 6=Sat) — Monday to Friday.
 *
 * ⚠️ This is the broadcast provider's campaign schedule and its real home is the provider, relayed
 * through email-gateway beside the capacity it already reports. Nothing upstream publishes it today,
 * so it is encoded here as the single named constant rather than derived from the observed past tail
 * (a schedule inferred from a handful of quiet days is a heuristic, not a fact). Delete this and read
 * the provider's own schedule the day it is served.
 */
export const SENDING_WEEKDAYS_UTC: readonly number[] = [1, 2, 3, 4, 5];

/** True when the fleet sends on that UTC calendar day. */
export function isSendingDay(dateIso: string): boolean {
  const weekday = new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
  return SENDING_WEEKDAYS_UTC.includes(weekday);
}

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
  /** In-flight (pre-today cohort) follow-ups DRAINED that day. null on past days. */
  inFlightSent: number | null;
  /** NEW (today-onward) budget-driven cohort emails DRAINED that day. null on past days. */
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
  /** Emails/day the healthy fleet can physically send. The per-day ceiling every future day is drained under. */
  dailyCapacity: number;
  /** Fleet new sequences/day at full budget — the cohort launched on every future SENDING day. */
  totalNewPerDay: number;
  /** Today's cohort size scaled to REMAINING budget (≤ totalNewPerDay). */
  todayNewOverride: number;
  /** Past real emails sent per day (email-grain), keyed by UTC date. */
  actualByDay: Map<string, number>;
  /** In-flight follow-up sends BECOMING DUE per day, keyed by UTC date (the provider's due dates). */
  inFlightByDay: Map<string, number>;
  summary: Omit<SendForecastSummary, "followupModel">;
}

/**
 * Cohort size (new sequences launched) on day `k`. Zero before today (those are the in-flight series'
 * responsibility), zero on a non-sending day (no budget is spent on a day the fleet does not send),
 * remaining-scaled today, full fleet rate on every later sending day.
 */
function cohortSize(k: string, todayIso: string, totalNewPerDay: number, todayNewOverride: number): number {
  if (k < todayIso) return 0;
  if (!isSendingDay(k)) return 0;
  if (k === todayIso) return todayNewOverride;
  return totalNewPerDay;
}

export function buildSendForecast(input: BuildSendForecastInput): {
  days: SendForecastDay[];
  summary: SendForecastSummary;
} {
  const { dates, todayIso, dailyCapacity, totalNewPerDay, todayNewOverride, actualByDay, inFlightByDay } = input;

  // Queues carried across days. Kept SEPARATE so each series stays attributable after draining.
  let queuedInFlight = 0;
  let queuedNew = 0;

  const days: SendForecastDay[] = dates.map((date) => {
    const isToday = date === todayIso;
    const isPast = date < todayIso;

    // Past days: only the real sent series is meaningful — it already happened, nothing to drain.
    if (isPast) {
      const actualSent = actualByDay.get(date) ?? null;
      return { date, isToday: false, actualSent, inFlightSent: null, forecastNew: null, total: actualSent };
    }

    // What becomes DUE today: the provider's provisioned steps, plus the convolution of new cohorts.
    queuedInFlight += inFlightByDay.get(date) ?? 0;
    for (const off of FOLLOWUP_OFFSETS_DAYS) {
      queuedNew += cohortSize(addUtcDays(date, -off), todayIso, totalNewPerDay, todayNewOverride);
    }

    // Today additionally carries the emails already sent so far today (disjoint from the queues, which
    // are provisioned-or-projected-not-yet-sent) — and they have already consumed part of the day's room.
    const actualSent = isToday ? (actualByDay.get(date) ?? null) : null;
    const room = isSendingDay(date) ? Math.max(0, dailyCapacity - (actualSent ?? 0)) : 0;

    // Already-provisioned work drains first; whatever room is left launches new cohorts.
    const inFlightSent = Math.min(queuedInFlight, room);
    queuedInFlight -= inFlightSent;
    const forecastNew = Math.min(queuedNew, room - inFlightSent);
    queuedNew -= forecastNew;

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
