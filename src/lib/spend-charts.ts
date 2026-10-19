/**
 * WHY A DAY COSTS WHAT IT COSTS, AND WHETHER THE SCOPE IS CONVERGING (owner 2026-10-19, SPEND-CHARTS-1019).
 *
 * A paying client asked "so it's not $0.04 per email sent? on what basis is the cost so high for a few?". The
 * dashboard showed a lifetime total per cost category and a "$ Spent" per day, nothing more. This module builds, for
 * ONE scope (an offer, a sales funnel campaign, or one pipe of it), one point per UTC day since its first activity:
 *
 *   - the MEASURED cost per outcome as of that day: every dollar committed up to the day ÷ every outcome of the
 *     scope's leg dated up to the day. Served while Learning too (owner 2026-10-19: "plus de learning qui offusque la
 *     data"); `learning` beside it says so, the UI greys it. Null only when nothing has been bought or nothing has
 *     been obtained yet (a cost per nothing cannot be divided), never because the scope is Learning.
 *   - the conversion BY ENTRY COHORT as of that day: of the people who ENTERED the leg on or before the day (the day
 *     they reached the leg's FROM step: the first message for an entry leg), the share that had reached its TO step
 *     by the day. A positive reply five days after the send counts for the SEND day. `cohortMature` says whether a
 *     day's cohort had the leg's full maturity duration (`lib/maturity.ts`) to answer; the recent days read low and
 *     are flagged, never dropped.
 *   - `learning`: the scope has not yet reached the leg's Learning bar (`legMaturity(leg).outcomesRequired`) in
 *     MATURE outcomes as of that day, the same bar every maturity verdict uses.
 *   - what the day's spend BOUGHT, per ACTION of the pipe (new prospects found, first contacts, follow-ups, writing
 *     the messages, reading the replies), each with its spend and, where the action has a countable unit, how many.
 *   - the EXPECTED value each line converges to (the scope's expected cost per outcome and expected conversion),
 *     served beside the series, never mixed into it.
 *
 * The LAST point is the scope's snapshot: every outcome and every entrant with no date lands there (counted, never
 * back-dated), so the last cost per outcome is the scope's whole spend ÷ its whole outcome count.
 *
 * PURE: no IO, no wall clock (`today` is passed in).
 */

/** One person of the scope, reduced to the two moments the charts read. */
export interface ChartPerson {
  /** Entered the leg (reached its FROM step). False: not in the conversion population at all. */
  entered: boolean;
  /** UTC day (YYYY-MM-DD) the person entered the leg; null when entered but undated. */
  enteredOn: string | null;
  /** Reached the leg's TO step. */
  converted: boolean;
  /** UTC day the person reached it; null when reached but undated. */
  convertedOn: string | null;
}

/** The ACTIONS a pipe's spend buys, in the customer's words, the same for every channel. */
export const SPEND_ACTION_KEYS = [
  "prospects_found",
  "first_contacts",
  "follow_ups",
  "messages_written",
  "replies_read",
  "notifications",
  "other",
] as const;
export type SpendActionKey = (typeof SPEND_ACTION_KEYS)[number];

export const SPEND_ACTION_LABEL: Record<SpendActionKey, string> = {
  prospects_found: "New prospects found",
  first_contacts: "First contacts",
  follow_ups: "Follow-ups",
  messages_written: "Messages written",
  replies_read: "Replies read",
  notifications: "Notifications",
  other: "Other",
};

/**
 * The funnel step an action works toward: finding prospects produces Lead found, a first contact and a follow-up
 * make the person Contacted. Null for the work around a step (writing, reading, notifying).
 */
export const SPEND_ACTION_STEP: Record<SpendActionKey, string | null> = {
  prospects_found: "lead_found",
  first_contacts: "contacted",
  follow_ups: "contacted",
  messages_written: null,
  replies_read: null,
  notifications: null,
  other: null,
};

/**
 * The unit an action is COUNTED in, or null when its runs are no unit a customer reads (a message is written by many
 * model calls; reading a reply is one judgment among many per person): those rows serve spend only.
 */
export const SPEND_ACTION_UNIT: Record<SpendActionKey, string | null> = {
  prospects_found: "prospect",
  first_contacts: "first contact",
  follow_ups: "follow-up",
  messages_written: null,
  replies_read: null,
  notifications: null,
  other: null,
};

const PROSPECT_SERVICES = new Set(["apollo-service", "lead-service", "human-service"]);
const WRITING_SERVICES = new Set(["chat-service", "content-generation-service", "scraping-service", "cloudflare-storage"]);
const NOTIFICATION_SERVICES = new Set(["postmark-service", "transactional-email-service"]);
/** A send step of a sequence, any sender: `<anything>-step-<n>`. */
const SEND_STEP = /-step-(\d+)$/;

/**
 * PURE. The action one runs task belongs to. Keyed on the RUN's service and task, never a cost (vendor) name, and
 * never a channel slug: a sequence step 1 is a first contact whoever sends it, a call placed is a first contact.
 */
export function spendActionOf(serviceName: string | null | undefined, taskName: string | null | undefined): SpendActionKey {
  const service = serviceName ?? "";
  const task = taskName ?? "";
  if (NOTIFICATION_SERVICES.has(service)) return "notifications";
  const step = SEND_STEP.exec(task);
  if (step) return Number(step[1]) <= 1 ? "first_contacts" : "follow_ups";
  if (task === "place-call") return "first_contacts";
  if (service === "chat-service" && task === "judgments") return "replies_read";
  if (WRITING_SERVICES.has(service)) return "messages_written";
  if (PROSPECT_SERVICES.has(service)) return "prospects_found";
  return "other";
}

/**
 * PURE. Whether a task's runs COUNT as actions of its category: the task that IS the act (a prospect served or
 * revealed, a message sent, a call placed). Verification, research and judgment runs around it spend, never count.
 */
export function countsAsAction(action: SpendActionKey, serviceName: string | null | undefined, taskName: string | null | undefined): boolean {
  if (SPEND_ACTION_UNIT[action] === null) return false;
  const task = taskName ?? "";
  if (action === "prospects_found") return (serviceName === "lead-service" && task === "lead-serve") || (serviceName === "apollo-service" && task === "enrichment");
  return true;
}

/** One (UTC day, service, task) row of the scope's committed spend and its runs carrying committed cost. */
export interface TaskSpendRow {
  date: string;
  serviceName: string | null;
  taskName: string | null;
  spendUsd: number;
  /** Runs of the task started that day carrying committed (actual or provisioned) cost. */
  runs: number;
}

export interface SpendActionDay {
  key: SpendActionKey;
  label: string;
  /** The funnel step the action works toward (`lead_found`, `contacted`), null for the work around a step. */
  step: string | null;
  /** The unit `actions` counts, null when the action serves spend only. */
  unit: string | null;
  spendUsd: number;
  /** How many actions that day; null when the action has no countable unit. */
  actions: number | null;
  /** spendUsd ÷ actions; null with no countable unit or no action that day. */
  costPerActionUsd: number | null;
}

/** PURE. The day's rows, folded per action, every action listed once in a fixed order (zeros dropped). */
export function foldSpendActions(rows: readonly TaskSpendRow[]): SpendActionDay[] {
  const spend = new Map<SpendActionKey, number>();
  const actions = new Map<SpendActionKey, number>();
  for (const r of rows) {
    const key = spendActionOf(r.serviceName, r.taskName);
    spend.set(key, (spend.get(key) ?? 0) + r.spendUsd);
    if (countsAsAction(key, r.serviceName, r.taskName)) actions.set(key, (actions.get(key) ?? 0) + r.runs);
  }
  return SPEND_ACTION_KEYS.filter((k) => spend.has(k)).map((key) => {
    const counted = SPEND_ACTION_UNIT[key] === null ? null : (actions.get(key) ?? 0);
    const usd = spend.get(key)!;
    return {
      key,
      label: SPEND_ACTION_LABEL[key],
      step: SPEND_ACTION_STEP[key],
      unit: SPEND_ACTION_UNIT[key],
      spendUsd: usd,
      actions: counted,
      costPerActionUsd: counted ? usd / counted : null,
    };
  });
}

/** The expected values the measured lines converge to, each with what it rests on (`lib/expected-return.ts` words). */
export interface SpendChartExpected {
  costPerOutcomeUsd: number | null;
  costPerOutcomeBasis: string | null;
  costPerOutcomeUnavailableReason: string | null;
  conversionRatePct: number | null;
  conversionBasis: string | null;
  conversionSource: string | null;
  conversionUnavailableReason: string | null;
  /** The scope's expected return (measured once mature, else its sales path model). */
  roiMultiple: number | null;
  roiBasis: string | null;
  roiUnavailableReason: string | null;
}

export interface SpendChartPoint {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** Committed spend that day. */
  spendUsd: number;
  cumulativeSpendUsd: number;
  /** Outcomes of the leg's step dated on or before the day (the last point also holds the undated ones). */
  cumulativeOutcomes: number;
  /** MEASURED, served while Learning: cumulativeSpendUsd ÷ cumulativeOutcomes. Null only at 0 outcomes or $0 spent. */
  costPerOutcomeUsd: number | null;
  /** People who entered the leg that day (its cohort). */
  entered: number;
  /** Of that day's cohort, how many reached the step by TODAY. */
  cohortOutcomes: number;
  /** cohortOutcomes ÷ entered, null with nobody entered. */
  cohortConversionPct: number | null;
  /** The day's cohort had the leg's whole maturity duration to convert. */
  cohortMature: boolean;
  /** Everybody who entered on or before the day. */
  cumulativeEntered: number;
  /** Of them, how many had reached the step BY THAT DAY. */
  cumulativeConverted: number;
  /** cumulativeConverted ÷ cumulativeEntered, as of the day. Null only with nobody entered: a measured 0 is drawn. */
  conversionRatePct: number | null;
  /** The same over the cohorts that were MATURE as of the day; null while none was. */
  matureConversionRatePct: number | null;
  /** Outcomes of the cohorts mature as of the day (what the Learning bar counts). */
  matureOutcomes: number;
  /** Below the leg's Learning bar as of the day. The figures above are served all the same. */
  learning: boolean;
  /** What the day's spend bought, per action. Σ spendUsd = the day's spend from the task read. */
  byAction: SpendActionDay[];
  /** spendUsd − Σ byAction (0 when the two reads agree; non-zero is printed, never folded in). Null without the task read. */
  byActionGapUsd: number | null;
}

export interface SpendChartInput {
  /** Committed spend per UTC day (the scope's own dated spend read). */
  spendByDay: ReadonlyMap<string, number>;
  /** Per (day, service, task) spend + runs; null when unreadable (then every `byAction` is empty, gap null). */
  taskRows: readonly TaskSpendRow[] | null;
  persons: readonly ChartPerson[];
  /** Leg maturity: days a cohort needs, and the Learning bar in mature outcomes. */
  durationDays: number;
  outcomesRequired: number;
  /** TODAY, UTC YYYY-MM-DD: the last point, and the clock cohort maturity is read on. */
  today: string;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * PURE. One point per UTC day from the scope's first activity (spend, entry or outcome) to `today`, gaps filled (a
 * day with nothing reads 0 spend and carries the cumulative figures forward). Empty when the scope has no activity.
 */
export function buildSpendChartDays(input: SpendChartInput): SpendChartPoint[] {
  const { spendByDay, taskRows, persons, durationDays, outcomesRequired, today } = input;
  const dated = [
    ...spendByDay.keys(),
    ...persons.flatMap((p) => [p.enteredOn, p.convertedOn].filter((d): d is string => d !== null)),
    ...(taskRows ?? []).map((r) => r.date),
  ].filter((d) => d <= today);
  const hasUndated = persons.some((p) => (p.entered && p.enteredOn === null) || (p.converted && p.convertedOn === null));
  if (dated.length === 0 && !hasUndated) return [];
  const first = dated.length > 0 ? dated.reduce((a, b) => (a < b ? a : b)) : today;

  const rowsByDay = new Map<string, TaskSpendRow[]>();
  for (const r of taskRows ?? []) (rowsByDay.get(r.date) ?? rowsByDay.set(r.date, []).get(r.date)!).push(r);

  // A day is read "as of its end": an undated entrant / outcome is placed on the LAST point only.
  const at = (d: string | null, isLast: boolean, day: string): boolean => (d === null ? isLast : d <= day);

  const points: SpendChartPoint[] = [];
  let cumulativeSpendUsd = 0;
  for (let day = first; day <= today; day = addDays(day, 1)) {
    const isLast = day === today;
    const spendUsd = spendByDay.get(day) ?? 0;
    cumulativeSpendUsd += spendUsd;
    // Cohorts mature as of `day`: entered at least `durationDays` before it.
    const matureCut = addDays(day, -durationDays);

    let cumulativeOutcomes = 0;
    let entered = 0;
    let cohortOutcomes = 0;
    let cumulativeEntered = 0;
    let cumulativeConverted = 0;
    let matureEntered = 0;
    let matureConverted = 0;
    for (const p of persons) {
      if (p.converted && at(p.convertedOn, isLast, day)) cumulativeOutcomes += 1;
      if (!p.entered) continue;
      if (p.enteredOn === day) {
        entered += 1;
        if (p.converted) cohortOutcomes += 1;
      }
      if (!at(p.enteredOn, isLast, day)) continue;
      const convertedBy = p.converted && at(p.convertedOn, isLast, day);
      cumulativeEntered += 1;
      if (convertedBy) cumulativeConverted += 1;
      // An undated entrant is IN the mature cohort (`lib/maturity.ts`: no date = old by construction), on the last
      // point only, where it is placed.
      if (p.enteredOn === null ? isLast : p.enteredOn <= matureCut) {
        matureEntered += 1;
        if (convertedBy) matureConverted += 1;
      }
    }

    const byAction = taskRows ? foldSpendActions(rowsByDay.get(day) ?? []) : [];
    const actionSum = byAction.reduce((s, a) => s + a.spendUsd, 0);
    points.push({
      date: day,
      spendUsd,
      cumulativeSpendUsd,
      cumulativeOutcomes,
      costPerOutcomeUsd: cumulativeOutcomes === 0 || cumulativeSpendUsd === 0 ? null : cumulativeSpendUsd / cumulativeOutcomes,
      entered,
      cohortOutcomes,
      cohortConversionPct: entered === 0 ? null : (cohortOutcomes / entered) * 100,
      cohortMature: day <= addDays(today, -durationDays),
      cumulativeEntered,
      cumulativeConverted,
      conversionRatePct: cumulativeEntered === 0 ? null : (cumulativeConverted / cumulativeEntered) * 100,
      matureConversionRatePct: matureEntered === 0 ? null : (matureConverted / matureEntered) * 100,
      matureOutcomes: matureConverted,
      learning: matureConverted < outcomesRequired,
      byAction,
      byActionGapUsd: taskRows ? roundCents(spendUsd - actionSum) : null,
    });
  }
  return points;
}

/** Sub-cent float noise of two sums of the same rows is not a gap. */
const roundCents = (usd: number): number => Math.round(usd * 1e6) / 1e6;
