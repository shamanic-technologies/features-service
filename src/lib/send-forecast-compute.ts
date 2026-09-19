/**
 * Pure assembly of the GLOBAL email send-forecast — `GET /internal/stats/send-forecast`.
 *
 * Answers TWO questions that are routinely confused for one, and keeps them apart:
 *
 *   CREATED — how many new sequences the budget LAUNCHES per day. Budget-driven, SEVEN days a week.
 *   SENT    — how many emails physically GO OUT per day. Throughput-driven, Monday-Friday.
 *
 * They are different processes on different calendars and the gap between them is the backlog.
 * Measured 2026-09-19: Sat 09-12 created 801 sequences and sent 0; Sun 09-13 created 756 and sent 0;
 * Mon 09-14 created 787 and sent 2,489. A single series cannot carry both, and a chart that draws
 * only the send side shows a weekend as an empty day — hiding a day the fleet spent its budget.
 *
 * The SEND half:
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
 *   THROUGHPUT, bounded by CAPACITY. `dailyCapacity` (the healthy mailbox count × their per-mailbox
 *   limits, reported by the provider on the same payload series 2 comes from) is a CEILING, not a
 *   RATE — and the distinction is the whole of this model. The fleet has never come close to it:
 *   measured 2026-09-19, its best day in 60 was 2,489 against a 4,105 ceiling, and on an ordinary
 *   day 112 sending mailboxes delivered 15.8 emails each against a ~47/day average limit — WITH a
 *   14,874-email backlog provisioned, so it was not demand-starved. What actually bounds it is the
 *   provider's own pacing: campaign schedules, per-recipient timezone windows, per-account ramp.
 *   So each day drains at `min(observedThroughput, dailyCapacity)` — the fleet's OWN recent
 *   sending-day median, which is a measurement rather than an aspiration. Anything due beyond that
 *   does NOT vanish and does NOT all land on one day: it stays in the queue for the next day.
 *
 *   ⚠️ Draining at the CEILING is what the first cut of this model did, and it is a bug that looks
 *   like a fix: it correctly stops the forecast exceeding capacity and then predicts a throughput
 *   never once observed, pinned flat on the ceiling for days. The tell is a plateau landing exactly
 *   on a round capacity number several days running — a queue draining against a real constraint
 *   does not do that.
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

/** How many of the most RECENT sending days the throughput median is taken over (~two weeks of weekdays). */
export const THROUGHPUT_WINDOW_DAYS = 10;

/**
 * The fleet's own recent send RATE: the MEDIAN of the last `THROUGHPUT_WINDOW_DAYS` days it sent on.
 *
 * ⚠️ RECENT is load-bearing and is not free — `actualByDay` is NOT the window this forecast renders.
 * The producer answers `groupBy=day` with the fleet's WHOLE history (204 days back to 2026-02-10 as
 * of 2026-09-19), so a median over everything it hands back is a median over the fleet's entire life,
 * most of which it spent far smaller. Measured: all-time gives 535.5/day against a recent 1,859 —
 * under-predicting by 3.5x, on a series whose own last five bars are on the same chart contradicting
 * it. Always take the tail, never the map.
 *
 * Median, not mean, so one outage or one unusually big day does not move the projection. Days with no
 * recorded send are absent from `actualByDay` and are excluded for free — weekends and outage days do
 * not drag it down, which is what we want: this is the rate on a day the fleet IS sending.
 *
 * `null` when nothing has been sent. The caller then has no measurement and falls back to the capacity
 * ceiling — the pre-measurement behaviour, and the only honest default: inventing a rate for a fleet
 * nobody has seen send would be worse than an optimistic one.
 */
export function observedDailyThroughput(actualByDay: Map<string, number>, todayIso: string): number | null {
  const recent = [...actualByDay.entries()]
    .filter(([date, sent]) => date < todayIso && Number.isFinite(sent) && sent > 0)
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)) // newest first
    .slice(0, THROUGHPUT_WINDOW_DAYS)
    .map(([, sent]) => sent)
    .sort((a, b) => a - b);
  if (recent.length === 0) return null;
  const mid = Math.floor(recent.length / 2);
  return recent.length % 2 === 1 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2;
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
  /**
   * Sequences the fleet CREATED that day (one per lead launched) — the budget's own output, on its
   * own calendar. Recorded for past days and today-so-far; null on future days, where `createdProjected`
   * answers instead. NOT an email count and NOT comparable to the send series.
   */
  createdActual: number | null;
  /** Sequences the budget will create that day. Today = remaining-budget scaled. null on past days. */
  createdProjected: number | null;
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
  /** The fleet's measured send rate on a sending day (median of its recent ones). null when unmeasured. */
  observedDailyThroughput: number | null;
  /** Emails already provisioned and waiting to go out — the gap creation has opened over sending. */
  queuedEmails: number;
  /** Sending days that queue takes to drain at the measured rate. null when the rate is unmeasured. */
  queuedSendingDays: number | null;
}

export interface BuildSendForecastInput {
  /** Contiguous UTC calendar dates, chronological, spanning the window (past tail → future horizon). */
  dates: string[];
  /** UTC "today" date string (must be one of `dates`). */
  todayIso: string;
  /** Emails/day the healthy fleet could physically send — a CEILING, never the drain rate. */
  dailyCapacity: number;
  /**
   * The fleet's measured recent send rate (`observedDailyThroughput`), which is what each day
   * actually drains at, bounded above by `dailyCapacity`. `null` when nothing has been sent in the
   * window, in which case the ceiling stands in for it.
   */
  observedThroughput: number | null;
  /** Fleet new sequences/day at full budget — the cohort launched on every future SENDING day. */
  totalNewPerDay: number;
  /** Today's cohort size scaled to REMAINING budget (≤ totalNewPerDay). */
  todayNewOverride: number;
  /** Past real emails sent per day (email-grain), keyed by UTC date. */
  actualByDay: Map<string, number>;
  /** Sequences created per day (sequence-grain), keyed by UTC date. Past + today-so-far. */
  createdByDay: Map<string, number>;
  /** In-flight follow-up sends BECOMING DUE per day, keyed by UTC date (the provider's due dates). */
  inFlightByDay: Map<string, number>;
  summary: Omit<SendForecastSummary, "followupModel" | "observedDailyThroughput" | "queuedEmails" | "queuedSendingDays">;
}

/**
 * Cohort size (new sequences LAUNCHED) on day `k`. Zero before today — those cohorts' follow-ups are
 * the in-flight series' responsibility. Today's is scaled to the REMAINING budget; every later day
 * gets the full fleet rate.
 *
 * ⚠️ EVERY day, weekends INCLUDED. Creation is driven by the daily budget and does not stop when the
 * fleet stops sending: measured 2026-09-19, the two weekend days before it created 801 and 756
 * sequences while sending nothing. A previous cut of this gated launches on `isSendingDay` — that
 * applied the SENDING calendar to CREATION, which is the confusion this module exists to remove. The
 * emails those weekend cohorts owe simply queue until Monday, which the drain below already handles.
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
  const { dates, todayIso, dailyCapacity, observedThroughput, totalNewPerDay, todayNewOverride, actualByDay, createdByDay, inFlightByDay } = input;
  // The rate a sending day drains at: what the fleet actually does, never more than it could do.
  const drainRate = observedThroughput === null ? dailyCapacity : Math.min(observedThroughput, dailyCapacity);

  // Queues carried across days. Kept SEPARATE so each series stays attributable after draining.
  let queuedInFlight = 0;
  let queuedNew = 0;

  const days: SendForecastDay[] = dates.map((date) => {
    const isToday = date === todayIso;
    const isPast = date < todayIso;

    // Past days: what happened, on both calendars. Nothing to drain — it already went out.
    if (isPast) {
      const actualSent = actualByDay.get(date) ?? null;
      return {
        date,
        isToday: false,
        createdActual: createdByDay.get(date) ?? null,
        createdProjected: null,
        actualSent,
        inFlightSent: null,
        forecastNew: null,
        total: actualSent,
      };
    }

    // What becomes DUE today: the provider's provisioned steps, plus the convolution of new cohorts.
    queuedInFlight += inFlightByDay.get(date) ?? 0;
    for (const off of FOLLOWUP_OFFSETS_DAYS) {
      queuedNew += cohortSize(addUtcDays(date, -off), todayIso, totalNewPerDay, todayNewOverride);
    }

    // Today additionally carries the emails already sent so far today (disjoint from the queues, which
    // are provisioned-or-projected-not-yet-sent) — and they have already consumed part of the day's room.
    const actualSent = isToday ? (actualByDay.get(date) ?? null) : null;
    const room = isSendingDay(date) ? Math.max(0, drainRate - (actualSent ?? 0)) : 0;

    // Already-provisioned work drains first; whatever room is left launches new cohorts.
    const inFlightSent = Math.min(queuedInFlight, room);
    queuedInFlight -= inFlightSent;
    const forecastNew = Math.min(queuedNew, room - inFlightSent);
    queuedNew -= forecastNew;

    const total = sumNullable([actualSent, inFlightSent, forecastNew]);
    return {
      date,
      isToday,
      // Today already has creations recorded; every later day is the budget's projection alone.
      createdActual: isToday ? (createdByDay.get(date) ?? null) : null,
      createdProjected: cohortSize(date, todayIso, totalNewPerDay, todayNewOverride),
      actualSent,
      inFlightSent,
      forecastNew,
      total,
    };
  });

  // The backlog: everything already provisioned across the horizon, and how long it takes to clear.
  // This is the gap creation has opened over sending, and it is the number anyone acts on.
  let queuedEmails = 0;
  for (const date of dates) {
    if (date < todayIso) continue;
    queuedEmails += inFlightByDay.get(date) ?? 0;
  }
  const drainForBacklog = observedThroughput === null ? null : Math.min(observedThroughput, dailyCapacity);
  const queuedSendingDays =
    drainForBacklog === null || drainForBacklog <= 0 ? null : queuedEmails / drainForBacklog;

  return {
    days,
    summary: {
      ...input.summary,
      followupModel: FOLLOWUP_MODEL_LABEL,
      observedDailyThroughput: observedThroughput,
      queuedEmails,
      queuedSendingDays,
    },
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
