/**
 * PIPELINE GENERATED OVER TIME, at the offer grain (owner 2026-11-07, PIPELINE-GENERATED-1107: the main chart of the
 * Today page, « pipeline generated over time, mesuré (ligne solide), et expected pour la suite (ligne pointillée) »).
 *
 * ONE pipeline basis (ONE-PIPELINE-1021): the dollars are the Deals board's, byte for byte. Each organisation adds
 * exactly what the lifecycle board says it is worth TODAY (`priceLifecycleBoard` `organizationValues`: its pipeline
 * rung value counted once + its won value), so the measured total IS the board's `totalUsd` (open pipeline + won).
 * What this read adds is WHEN: each organisation's value is placed on the day our outreach first reached it (the
 * earliest dated signal of any of its people, the first contact in practice). The series is cumulative, so it only
 * grows, and its last measured point is the measured total.
 *
 * It is a FORECAST in dollars (the gtm-factory framework: « a pipeline in dollars is a forecast, not WIP »): served
 * beside no cost, never a return's numerator (ROI-CONSISTENCY-1103). A cohort view: a past day reads what the people
 * first reached that day are worth today (a lead ruled out since then adds 0 to its day; a contacted lead's value
 * expires 30 days after its last send, the board's own rule).
 *
 * EXPECTED ahead: the measured total grows at the offer's own pace since inception (measured total ÷ days from the
 * first day to today, both counted), carried `EXPECTED_HORIZON_DAYS` days forward. Nothing running on the offer = no
 * more pipeline expected: the expected days stay flat at the measured total (`expectedFlatReason`).
 *
 * An organisation none of whose people carries a date is counted from the first day (`undatedUsd` says how much), so
 * the measured total still equals the last measured point. PURE.
 */

/** How far the expected (dotted) continuation runs past today. */
export const EXPECTED_HORIZON_DAYS = 30;

export interface PipelineGeneratedPoint {
  date: string;
  /** `measured` up to today (included), `expected` after. */
  kind: "measured" | "expected";
  /** Value first reached that day (measured), or the pace added that day (expected). */
  generatedUsd: number;
  /** Cumulative since the first day. */
  cumulativeUsd: number;
}

export type ExpectedFlatReason = "offer_not_running" | "no_pipeline_yet";

export interface PipelineGeneratedSeries {
  /** Pipeline generated to date (the Deals board's total: open pipeline + won). Null with `unvaluedReason`. */
  measuredUsd: number | null;
  /** `measuredUsd` + the expected continuation over `expectedHorizonDays`. Null with `unvaluedReason`. */
  expectedUsd: number | null;
  expectedHorizonDays: number;
  /** Measured total ÷ days since the first day (both ends counted). Null with `unvaluedReason`. */
  dailyPaceUsd: number | null;
  /** Why the expected days stay flat at the measured total (null = they grow at the pace). */
  expectedFlatReason: ExpectedFlatReason | null;
  firstDay: string | null;
  today: string;
  undatedUsd: number | null;
  points: PipelineGeneratedPoint[];
}

const round = (n: number): number => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function buildPipelineGeneratedSeries(input: {
  /** What each organisation adds (`priceLifecycleBoard` `organizationValues`); null when the offer has no economics. */
  organizationValues: ReadonlyMap<string, number> | null;
  /** Each organisation's first day (YYYY-MM-DD), when one of its people carries a date. */
  firstDayOf: ReadonlyMap<string, string>;
  /** Whether a campaign of the offer is running now. */
  running: boolean;
  /** YYYY-MM-DD (UTC). */
  today: string;
  horizonDays?: number;
}): PipelineGeneratedSeries {
  const horizon = input.horizonDays ?? EXPECTED_HORIZON_DAYS;
  if (input.organizationValues === null) {
    return {
      measuredUsd: null,
      expectedUsd: null,
      expectedHorizonDays: horizon,
      dailyPaceUsd: null,
      expectedFlatReason: null,
      firstDay: null,
      today: input.today,
      undatedUsd: null,
      points: [],
    };
  }
  const byDay = new Map<string, number>();
  let undated = 0;
  for (const [org, v] of input.organizationValues) {
    if (!(v > 0)) continue;
    const day = input.firstDayOf.get(org);
    // A day after today (clock skew) lands on today: the measured line never runs past today.
    if (day) byDay.set(day > input.today ? input.today : day, (byDay.get(day > input.today ? input.today : day) ?? 0) + v);
    else undated += v;
  }
  const days = [...byDay.keys()].sort();
  const firstDay = days[0] ?? (undated > 0 ? input.today : null);
  const points: PipelineGeneratedPoint[] = [];
  let cumulative = 0;
  let measured = 0;
  if (firstDay !== null) {
    for (let d = firstDay, i = 0; d <= input.today; d = addDays(d, 1), i += 1) {
      const generated = (byDay.get(d) ?? 0) + (i === 0 ? undated : 0);
      cumulative += generated;
      points.push({ date: d, kind: "measured", generatedUsd: round(generated), cumulativeUsd: round(cumulative) });
    }
    measured = round(cumulative);
  }
  const elapsedDays = points.length;
  const pace = elapsedDays > 0 ? measured / elapsedDays : 0;
  const flat: ExpectedFlatReason | null = measured <= 0 ? "no_pipeline_yet" : !input.running ? "offer_not_running" : null;
  const step = flat === null ? pace : 0;
  for (let k = 1; k <= horizon; k += 1) {
    points.push({ date: addDays(input.today, k), kind: "expected", generatedUsd: round(step), cumulativeUsd: round(measured + step * k) });
  }
  return {
    measuredUsd: measured,
    expectedUsd: round(measured + step * horizon),
    expectedHorizonDays: horizon,
    dailyPaceUsd: round(pace),
    expectedFlatReason: flat,
    firstDay,
    today: input.today,
    undatedUsd: round(undated),
    points,
  };
}

/** Each organisation's first day: the earliest dated signal of any of its people (YYYY-MM-DD). */
export function firstDayByOrganization(
  persons: readonly { leadId: string; orgId: string | null; signalDates?: Record<string, string | null> }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of persons) {
    const key = p.orgId ? `org:${p.orgId}` : `lead:${p.leadId}`;
    for (const iso of Object.values(p.signalDates ?? {})) {
      if (!iso) continue;
      const day = iso.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const cur = out.get(key);
      if (cur === undefined || day < cur) out.set(key, day);
    }
  }
  return out;
}
