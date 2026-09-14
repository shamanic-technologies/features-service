/**
 * THE FLEET'S MONTHLY RUN-RATE, SPLIT IN TWO — and BOTH halves are now SUMS, which is the whole
 * change. A subtraction between two figures that were never measured the same way is not a quantity,
 * and this one came out NEGATIVE in production; a sum over the self-serve side cannot.
 *
 * A SELF-SERVE (SaaS) customer pays THROUGH the product, so what they are worth per month IS their
 * daily budget × 30. An AGENCY does not: it hands over cash at its own discretion and somebody then
 * DECIDES how that cash is split into daily budgets across its brands, so budget × 30 answers "how
 * did we spread their money", not "what is this customer worth" — the only true figure there is the
 * one a human states in `stated_monthly_amounts`.
 *
 *   AGENCY     = Σ of the STATED amounts in force on the period's reference date.
 *   SELF-SERVE = Σ, over the self-serve (org, brand) pairs, of each pair's daily budget × 30 on that
 *                date — counting a pair ONLY on a day it was genuinely earning (see the four
 *                conditions below).
 *   TOTAL      = agency + self-serve. Disjoint sets, so they always add.
 *
 * WHAT SUPERSEDES WHAT. Until 2026-09-14 the self-serve half was `the fleet's recorded committed
 * snapshot MINUS the agency side's replayed budget`. The two sides of that subtraction were recorded
 * differently — the snapshot counts RUNNING money for ACTIVE pairs, the replay counts CONFIGURED
 * brand ceilings whether or not anything was running — so for August 2026 the subtrahend exceeded
 * the total, the remainder was −$720/month, and the period had to be published as unmeasurable. That
 * whole mechanism is gone, together with `selfServeUnmeasurableReason:
 * "agency_contribution_exceeds_recorded_total"`, which can no longer occur.
 *
 * THE FOUR CONDITIONS A DAY'S BUDGET MUST MEET TO BE MRR, and the service that records each:
 *   1. PAYMENT HAD NOT STOPPED        — billing-service payment-stopped periods
 *   2. THE CAMPAIGN WAS RUNNING       — campaign-service recorded status
 *   3. AN AMOUNT WAS IN FORCE         — billing-service daily-budget by-day (the brand grain, the
 *                                       finest billing genuinely records over time)
 *   4. SOMEBODY WAS LEFT TO CONTACT   — campaign-service recorded audience availability
 * None of them is invented here; this module only joins them.
 *
 * TWO ERAS, AND THEY ARE NEVER BLENDED SILENTLY. campaign-service's status and audience records open
 * on the day that service shipped them, so every earlier day is `not_recorded` on conditions 2 and 4.
 * For those days the qualification falls back to the strongest thing that DOES reach back: the pair's
 * own billed cold-email ACTIVITY. Run-presence and run-silence are treated ASYMMETRICALLY, never as a
 * boolean — one day of billed spend marks the pair as working for a whole window either side of it
 * (a live campaign is idle on plenty of days), while silence concludes nothing until the entire
 * window is empty. Any day whose verdict rested on that fallback marks its bucket
 * `selfServeBasis: "approximated"`, and `selfServeApproximatedPairCount` says how many pairs it was,
 * so a consumer labels the period rather than presenting it as measured.
 *
 * AN AMOUNT IS NEVER APPROXIMATED — only the QUALIFICATION is. A pair billing holds no budget record
 * for on a day contributes NOTHING, however obviously it was working, because inventing the amount is
 * the one thing that would put a number on the wire no service ever recorded. The gap is made VISIBLE
 * instead of guessed: `selfServeUnrecordedBudgetPairCount` counts exactly the pairs that looked
 * active on the reference date while billing held no amount for them, so a reader can see the
 * under-statement rather than have it silently folded in.
 *
 * WHICH ORGS ARE AGENCY IS DERIVED FROM THE STATED ROWS — an org carrying at least one — and the
 * exclusion is taken over that org's WHOLE brand set, not only its stated brands. No org id lives in
 * code; a second agency later needs no change here.
 */
import { bucketOf, enumerateBuckets } from "./active-users-compute.js";
import { committedPointsByPeriod } from "./committed-mrr-compute.js";
import { MRR_DAY_MULTIPLE } from "./committed-mrr-store.js";
import { ARR_MONTH_MULTIPLE } from "./committed-mrr-compute.js";
import type { StatedAmountRow } from "./stated-monthly-amounts-store.js";
import type { CampaignDayAnswer, FactBasis, PaymentStoppedFacts } from "./mrr-day-facts-clients.js";

/**
 * How many days either side of a reference date count as evidence the pair was working, when
 * campaign-service recorded nothing. A cold-email campaign is idle on plenty of individual days, so a
 * same-day test would read almost every live campaign as stopped; a fortnight centred on the day is
 * the widest silence that still means something.
 */
export const ACTIVITY_WINDOW_DAYS = 7;

/** Round a USD amount to 2 decimals, FP-safe. */
function usd2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Composite key for an (org, brand) pair — budgets, activity and stated amounts all key on the pair. */
export function pairKey(orgId: string, brandId: string): string {
  return `${orgId}::${brandId}`;
}

/** Shift a `YYYY-MM-DD` day by N days (may be negative), in UTC. */
function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface MrrSplitBucket {
  /** Bucket label: `YYYY-MM` (month) or `YYYY-Www` ISO week. */
  period: string;
  /** UTC start date of the bucket (`YYYY-MM-DD`): the month's 1st or the ISO week's Monday. For charting. */
  periodStart: string;
  /** The UTC day the point was read as of — the last snapshot in the period, or today for the current one. */
  referenceDate: string;
  /** Σ STATED monthly amounts in force on `referenceDate`, USD. Never those brands' budget × 30. */
  agencyMrrUsd: number;
  /** Agency ARR = agencyMrrUsd × 12, USD. */
  agencyArrUsd: number;
  /**
   * Σ, over the SELF-SERVE pairs that were earning on `referenceDate`, of their daily budget × 30.
   * A sum, so it can never be negative. `null` only when NOTHING about that day is on record (see
   * `selfServeUnmeasurableReason`) — never a 0 standing in for "we could not read this".
   */
  selfServeMrrUsd: number | null;
  /** Self-serve ARR = selfServeMrrUsd × 12, USD. null whenever the MRR is. */
  selfServeArrUsd: number | null;
  /** agencyMrrUsd + selfServeMrrUsd — disjoint halves, so they always add. null whenever the self-serve half is. */
  totalMrrUsd: number | null;
  /** Total ARR = totalMrrUsd × 12, USD. null whenever the MRR is. */
  totalArrUsd: number | null;
  /**
   * `recorded` = every pair's QUALIFICATION came from a producer's record. `approximated` = at least
   * one rested on billed-activity evidence because campaign-service's record does not reach this day.
   * null whenever the self-serve half is unmeasurable. A consumer must LABEL an approximated period
   * rather than present it as measured. Independent of
   * `selfServeUnrecordedBudgetPairCount`, which is an under-statement rather than an approximation.
   */
  selfServeBasis: FactBasis | null;
  /** How many self-serve pairs contributed a positive amount on `referenceDate`. */
  selfServePairCount: number;
  /** Of those decisions, how many rested on activity evidence rather than a producer's record. */
  selfServeApproximatedPairCount: number;
  /**
   * Self-serve pairs that looked ACTIVE on `referenceDate` while billing held no amount for them, so
   * they contributed nothing. The visible size of the under-statement — never silently filled in.
   */
  selfServeUnrecordedBudgetPairCount: number;
  /** Why the self-serve half could not be measured at all, or null when it was. */
  selfServeUnmeasurableReason: "no_records_for_period" | null;
  /**
   * The agency side's qualifying daily budget × 30 on `referenceDate`, computed by the SAME four
   * conditions as the self-serve half. Served so an agency brand nobody has stated an amount for is
   * visible: when this exceeds `agencyMrrUsd`, that difference is in neither half.
   */
  agencyBudgetMrrUsd: number;
  /** Basis of `agencyBudgetMrrUsd`, on the same rule as `selfServeBasis`. */
  agencyBudgetBasis: FactBasis | null;
  /**
   * The fleet committed run-rate this service RECORDED for this period (Σ active running budget × 30
   * as of the reference date), served for comparison. It is NOT the sum of the two halves above and
   * is not claimed to be: it counts running money for active pairs on a snapshot, while the halves
   * are replayed from each producer's own record of the configured amount.
   */
  committedMrrUsd: number;
  /** Point-over-point growth of `totalMrrUsd` vs the previous MEASURED bucket, percent (1-decimal). */
  growthPct: number | null;
}

export interface MrrSplit {
  /** LIVE agency MRR — Σ stated amounts in force today. */
  currentAgencyMrrUsd: number;
  currentAgencyArrUsd: number;
  /** LIVE self-serve MRR — Σ today's qualifying self-serve budgets × 30. The current bucket's figure. */
  currentSelfServeMrrUsd: number | null;
  currentSelfServeArrUsd: number | null;
  /** LIVE total = agency + self-serve. */
  currentTotalMrrUsd: number | null;
  currentTotalArrUsd: number | null;
  /** Basis of the live self-serve figure — `approximated` while campaign-service's record is young. */
  currentSelfServeBasis: FactBasis | null;
  /** The agency side's qualifying budget × 30 today, on the same four conditions. */
  currentAgencyBudgetMrrUsd: number;
  /**
   * The earliest UTC day campaign-service has ANY recorded answer about a campaign running or its
   * audience. Every bucket whose reference date is before this is necessarily approximated; null when
   * nothing is recorded yet. The era boundary, measured rather than declared.
   */
  earningRecordBeginsOn: string | null;
  /** The orgs the stated rows identify as agency — derived, never hardcoded. Sorted. */
  agencyOrgIds: string[];
  /** Every (org, brand) pair excluded from the self-serve half, as `orgId::brandId`. Sorted. */
  agencyPairKeys: string[];
  monthly: MrrSplitBucket[];
  weekly: MrrSplitBucket[];
}

/**
 * Is a stated row in force on `day`? Both bounds INCLUSIVE. A null `endDate` is "still running"; a
 * null `startDate` is "since this brand's FIRST DAY OF BILLED SPEND", supplied per pair by the
 * caller. A brand that never billed a day has no lower bound to apply, so the row is in force from
 * the start rather than silently never counted. Pure.
 */
export function statedAmountInForce(row: StatedAmountRow, day: string, firstBilledDay: string | null): boolean {
  const lower = row.startDate ?? firstBilledDay;
  if (lower !== null && day < lower) return false;
  if (row.endDate !== null && day > row.endDate) return false;
  return true;
}

/** Σ of every stated amount in force on `day`, USD. Pure. */
export function agencyStatedMrrOn(
  rows: StatedAmountRow[],
  day: string,
  firstBilledDayByPair: Map<string, string | null>,
): number {
  let total = 0;
  for (const row of rows) {
    const firstBilled = firstBilledDayByPair.get(pairKey(row.orgId, row.brandId)) ?? null;
    if (statedAmountInForce(row, day, firstBilled)) total += row.amountUsd;
  }
  return total;
}

/**
 * Was this org's payment stopped on `day`? `true` / `false` from billing's episodes, and `null` when
 * the day precedes the record — where the ABSENCE of an episode is not evidence that payment was on,
 * which is exactly the conflation billing's `recordBeginsAt` exists to prevent. Pure.
 */
export function paymentStoppedOn(facts: PaymentStoppedFacts | undefined, day: string): boolean | null {
  if (!facts) return null;
  if (facts.recordBeginsOn === null || day < facts.recordBeginsOn) return null;
  for (const p of facts.periods) {
    if (day >= p.startedOn && (p.endedOn === null || day <= p.endedOn)) return true;
  }
  return false;
}

/**
 * Did this pair bill any cold-email spend within `ACTIVITY_WINDOW_DAYS` either side of `day`?
 *
 * The asymmetry the fallback rests on: ONE day of billed spend turns the whole window on, because a
 * campaign that spent money that week was plainly being run; silence turns nothing off until the
 * entire window is empty, because a live-but-idle campaign is indistinguishable from a stopped one on
 * any single day. Pure.
 */
export function activeNear(activityDays: Set<string> | undefined, day: string, window = ACTIVITY_WINDOW_DAYS): boolean {
  if (!activityDays || activityDays.size === 0) return false;
  for (let offset = -window; offset <= window; offset++) {
    if (activityDays.has(shiftDay(day, offset))) return true;
  }
  return false;
}

/**
 * The brand's RECORDED earning verdict from its campaigns' answers on one day, or `null` when none of
 * them answered.
 *
 * A campaign campaign-service records as `stopped` was not earning, full stop — the audience axis
 * cannot rescue it — so that is a RECORDED false even though the producer reports `earning: null`
 * while its own audience record is still empty. An `ongoing` campaign needs the audience axis to be
 * recorded too before it can answer either way. A brand is earning if ANY of its campaigns was. Pure.
 */
export function recordedEarningOf(answers: CampaignDayAnswer[]): boolean | null {
  let sawRecordedNo = false;
  for (const a of answers) {
    if (a.status === "stopped") {
      sawRecordedNo = true;
      continue;
    }
    if (a.status !== "ongoing") continue; // status not recorded — this campaign says nothing
    if (a.audience === "available") return true;
    if (a.audience === "exhausted") sawRecordedNo = true;
    // ongoing + audience not recorded: unknown, and no other campaign is helped by it
  }
  return sawRecordedNo ? false : null;
}

/** One pair's contribution to one day's run-rate, and what evidence it rested on. */
export interface PairDayVerdict {
  /** The pair's qualifying monthly contribution, USD (daily budget × 30), or 0. */
  mrrUsd: number;
  /** `approximated` when any input fell back to activity evidence. */
  basis: FactBasis;
  /** The pair looked active while billing held no amount for it — a visible, uncounted gap. */
  budgetUnrecordedWhileActive: boolean;
}

/** The per-day facts the evaluation joins, all keyed the way each producer serves them. */
export interface DayFacts {
  /** pair key → (day → recorded configured brand daily budget, USD). An absent day is NOT RECORDED. */
  budgetByDay: Map<string, Map<string, number>>;
  /** pair key → the UTC days it billed cold-email spend (activity evidence for the earlier era). */
  activityDays: Map<string, Set<string>>;
  /** pair key → (day → campaign-service's recorded verdict: true / false / null = not recorded). */
  recordedEarning: Map<string, Map<string, boolean | null>>;
  /** org id → billing's payment-stopped facts. */
  paymentByOrg: Map<string, PaymentStoppedFacts>;
}

/**
 * Does this pair's budget count as MRR on `day`, and on what evidence? The four conditions in order,
 * stopping at the first that answers no. Pure.
 */
export function evaluatePairDay(key: string, orgId: string, day: string, facts: DayFacts): PairDayVerdict {
  let basis: FactBasis = "recorded";

  // 1. BILLING ACTIVE. A stopped payment ends it outright; an unrecorded one is a fallback, not a yes.
  const stopped = paymentStoppedOn(facts.paymentByOrg.get(orgId), day);
  if (stopped === true) return { mrrUsd: 0, basis: "recorded", budgetUnrecordedWhileActive: false };
  if (stopped === null) basis = "approximated";

  // 2 + 4. RUNNING, AND SOMEBODY LEFT TO CONTACT. Recorded when campaign-service reaches this day,
  // else inferred from the pair's own billed activity around it.
  const recorded = facts.recordedEarning.get(key)?.get(day) ?? null;
  let earning: boolean;
  if (recorded !== null) {
    earning = recorded;
  } else {
    earning = activeNear(facts.activityDays.get(key), day);
    basis = "approximated";
  }
  if (!earning) return { mrrUsd: 0, basis, budgetUnrecordedWhileActive: false };

  // 3. AN AMOUNT IN FORCE. Never approximated: a pair billing holds no amount for contributes
  // nothing, and the gap is COUNTED rather than filled with a number nobody recorded. That is an
  // under-statement, not an approximation — a different fact, so it rides its own field and does not
  // move `basis`, which says only what the QUALIFICATION rested on.
  const amount = facts.budgetByDay.get(key)?.get(day);
  if (amount === undefined) return { mrrUsd: 0, basis, budgetUnrecordedWhileActive: true };
  if (amount <= 0) return { mrrUsd: 0, basis, budgetUnrecordedWhileActive: false };

  return { mrrUsd: amount * MRR_DAY_MULTIPLE, basis, budgetUnrecordedWhileActive: false };
}

/** One side's summed run-rate on one day, with the evidence it rested on. */
export interface SideSum {
  mrrUsd: number;
  /** `approximated` when ANY pair's qualification rested on activity evidence, whatever it decided. */
  basis: FactBasis;
  /** Pairs that contributed a positive amount. */
  pairCount: number;
  /** Of those, how many were qualified on activity evidence rather than a producer's record. */
  approximatedPairCount: number;
  /** Pairs that looked active while billing held no amount — the visible size of the under-statement. */
  unrecordedBudgetPairCount: number;
  /** True when NOTHING on this day was on record for any pair — the only unmeasurable case. */
  nothingRecorded: boolean;
}

/** Σ over a set of pairs of their qualifying budget × 30 on `day`. A sum: it can never be negative. Pure. */
export function sumSideOn(pairKeys: string[], day: string, facts: DayFacts): SideSum {
  let mrrUsd = 0;
  let pairCount = 0;
  let approximatedPairCount = 0;
  let unrecordedBudgetPairCount = 0;
  let anyApproximated = false;
  let anyRecordedInput = false;

  for (const key of pairKeys) {
    const orgId = key.slice(0, key.indexOf("::"));
    const verdict = evaluatePairDay(key, orgId, day, facts);
    if (verdict.basis === "approximated") anyApproximated = true;
    // A pair EXCLUDED on recorded evidence is as much a recorded input as one that counted.
    if (verdict.basis === "recorded") anyRecordedInput = true;
    if (facts.budgetByDay.get(key)?.has(day)) anyRecordedInput = true;
    if (verdict.mrrUsd > 0) {
      mrrUsd += verdict.mrrUsd;
      pairCount += 1;
      if (verdict.basis === "approximated") approximatedPairCount += 1;
    }
    if (verdict.budgetUnrecordedWhileActive) unrecordedBudgetPairCount += 1;
  }

  return {
    mrrUsd,
    basis: anyApproximated ? "approximated" : "recorded",
    pairCount,
    approximatedPairCount,
    unrecordedBudgetPairCount,
    nothingRecorded: pairKeys.length > 0 && !anyRecordedInput,
  };
}

export interface MrrSplitInputs {
  /** Every stated monthly amount on record. Empty ⇒ the fleet is entirely self-serve. */
  statedRows: StatedAmountRow[];
  /** Every cold-email (org, brand) pair, from the accounts audit — the universe both sides are drawn from. */
  allPairs: Array<{ orgId: string; brandId: string }>;
  /** The four per-day facts, each read from the service that records it. */
  facts: DayFacts;
  /** First UTC day of billed spend per pair key — the floor for a stated row with no start. null = never billed. */
  firstBilledDayByPair: Map<string, string | null>;
  /** Recorded committed snapshots (date → fleet committed MRR, USD), oldest→newest. Periods + comparison only. */
  snapshots: Array<{ date: string; mrrUsd: number }>;
  /** The LIVE fleet committed MRR (accounts-audit Σ ACTIVE running budget × 30) — served beside, not subtracted. */
  currentMrrUsd: number;
  /** Earliest UTC day campaign-service has any recorded status/audience answer, or null. */
  earningRecordBeginsOn: string | null;
}

/** The agency orgs, derived: any org carrying at least one stated amount, whatever its date range. Pure. */
export function agencyOrgIdsOf(statedRows: StatedAmountRow[]): string[] {
  return [...new Set(statedRows.map((r) => r.orgId))].sort();
}

/**
 * Every (org, brand) pair whose org is on the agency side — the set excluded from the self-serve
 * half. Drawn from the WHOLE cold-email pair universe, so an agency brand nobody has stated an amount
 * for still leaves the SaaS figure. Pure.
 */
export function agencyPairKeysOf(
  statedRows: StatedAmountRow[],
  allPairs: Array<{ orgId: string; brandId: string }>,
): string[] {
  const agencyOrgs = new Set(agencyOrgIdsOf(statedRows));
  const keys = new Set<string>();
  for (const p of allPairs) {
    if (agencyOrgs.has(p.orgId)) keys.add(pairKey(p.orgId, p.brandId));
  }
  // A stated pair is agency by definition, even if the membership read has not caught up to it.
  for (const r of statedRows) keys.add(pairKey(r.orgId, r.brandId));
  return [...keys].sort();
}

/** Every pair NOT on the agency side, sorted — the set the self-serve half is summed over. Pure. */
export function selfServePairKeysOf(
  statedRows: StatedAmountRow[],
  allPairs: Array<{ orgId: string; brandId: string }>,
): string[] {
  const agency = new Set(agencyPairKeysOf(statedRows, allPairs));
  return [...new Set(allPairs.map((p) => pairKey(p.orgId, p.brandId)))].filter((k) => !agency.has(k)).sort();
}

/** The reference dates the split will be read on — one per emitted period, deduped and sorted. Pure. */
export function referenceDatesOf(
  snapshots: Array<{ date: string; mrrUsd: number }>,
  todayIso: string,
  windows: { weeks: number; months: number },
  currentMrrUsd: number,
): string[] {
  const dates = new Set<string>();
  for (const g of ["month", "week"] as const) {
    const buckets = enumerateBuckets(todayIso, g, g === "month" ? windows.months : windows.weeks);
    const points = committedPointsByPeriod(snapshots, buckets, g, bucketOf(todayIso, g).periodStart, currentMrrUsd, todayIso);
    for (const p of points.values()) dates.add(p.referenceDate);
  }
  return [...dates].sort();
}

/** Build one granularity's split series over the periods the committed series emits. Pure. */
function buildSeries(
  inputs: MrrSplitInputs,
  agencyKeys: string[],
  selfServeKeys: string[],
  buckets: Array<{ period: string; periodStart: string }>,
  g: "week" | "month",
  todayIso: string,
): MrrSplitBucket[] {
  const points = committedPointsByPeriod(
    inputs.snapshots,
    buckets,
    g,
    bucketOf(todayIso, g).periodStart,
    inputs.currentMrrUsd,
    todayIso,
  );

  const emitted: MrrSplitBucket[] = [];
  for (const b of buckets) {
    const point = points.get(b.periodStart);
    if (!point) continue; // no recorded snapshot in this period → omit, exactly as the committed series does

    const day = point.referenceDate;
    const agencyMrr = agencyStatedMrrOn(inputs.statedRows, day, inputs.firstBilledDayByPair);
    const self = sumSideOn(selfServeKeys, day, inputs.facts);
    const agencyBudget = sumSideOn(agencyKeys, day, inputs.facts);

    // A sum cannot go negative, so the only thing that can make it unmeasurable is having no record
    // at all for the day — which is a different statement from "the SaaS business was worth nothing".
    const unmeasurable = self.nothingRecorded;
    const selfServeMrr = unmeasurable ? null : self.mrrUsd;
    const totalMrr = selfServeMrr === null ? null : agencyMrr + selfServeMrr;

    // Growth against the previous MEASURED point — never compared across a gap.
    const prevMeasured = [...emitted].reverse().find((e) => e.totalMrrUsd !== null)?.totalMrrUsd ?? null;
    const growthPct =
      totalMrr !== null && prevMeasured !== null && prevMeasured > 0
        ? Math.round(((totalMrr - prevMeasured) / prevMeasured) * 1000) / 10
        : null;

    emitted.push({
      period: b.period,
      periodStart: b.periodStart,
      referenceDate: day,
      agencyMrrUsd: usd2(agencyMrr),
      agencyArrUsd: usd2(agencyMrr * ARR_MONTH_MULTIPLE),
      selfServeMrrUsd: selfServeMrr === null ? null : usd2(selfServeMrr),
      selfServeArrUsd: selfServeMrr === null ? null : usd2(selfServeMrr * ARR_MONTH_MULTIPLE),
      totalMrrUsd: totalMrr === null ? null : usd2(totalMrr),
      totalArrUsd: totalMrr === null ? null : usd2(totalMrr * ARR_MONTH_MULTIPLE),
      selfServeBasis: unmeasurable ? null : self.basis,
      selfServePairCount: self.pairCount,
      selfServeApproximatedPairCount: self.approximatedPairCount,
      selfServeUnrecordedBudgetPairCount: self.unrecordedBudgetPairCount,
      selfServeUnmeasurableReason: unmeasurable ? "no_records_for_period" : null,
      agencyBudgetMrrUsd: usd2(agencyBudget.mrrUsd),
      agencyBudgetBasis: agencyKeys.length === 0 ? null : agencyBudget.basis,
      committedMrrUsd: usd2(point.mrrUsd),
      growthPct,
    });
  }
  return emitted;
}

/**
 * Build the whole agency / self-serve / total split — live figures plus the monthly and weekly
 * history, over exactly the periods the committed series emits (never a fabricated point for a day no
 * snapshot recorded). Pure; every read the facts need is done by the caller.
 *
 * The LIVE figures go through the SAME evaluator as the history, so the scalar and the current
 * bucket are one number rather than two answers to one question on one screen. They therefore no
 * longer cancel against `currentMrrUsd`: that figure counts RUNNING money for active pairs, while
 * these count each producer's recorded CONFIGURED amount gated on all four conditions — including
 * audience exhaustion, which the accounts-audit verdict has never known about.
 */
export function buildMrrSplit(inputs: MrrSplitInputs, now: Date, windows: { weeks: number; months: number }): MrrSplit {
  const todayIso = now.toISOString().slice(0, 10);
  const agencyKeys = agencyPairKeysOf(inputs.statedRows, inputs.allPairs);
  const selfServeKeys = selfServePairKeysOf(inputs.statedRows, inputs.allPairs);

  const monthly = buildSeries(inputs, agencyKeys, selfServeKeys, enumerateBuckets(todayIso, "month", windows.months), "month", todayIso);
  const weekly = buildSeries(inputs, agencyKeys, selfServeKeys, enumerateBuckets(todayIso, "week", windows.weeks), "week", todayIso);

  const currentAgencyMrr = agencyStatedMrrOn(inputs.statedRows, todayIso, inputs.firstBilledDayByPair);
  const self = sumSideOn(selfServeKeys, todayIso, inputs.facts);
  const agencyBudget = sumSideOn(agencyKeys, todayIso, inputs.facts);
  const currentSelfServeMrr = self.nothingRecorded ? null : self.mrrUsd;
  const currentTotalMrr = currentSelfServeMrr === null ? null : currentAgencyMrr + currentSelfServeMrr;

  return {
    currentAgencyMrrUsd: usd2(currentAgencyMrr),
    currentAgencyArrUsd: usd2(currentAgencyMrr * ARR_MONTH_MULTIPLE),
    currentSelfServeMrrUsd: currentSelfServeMrr === null ? null : usd2(currentSelfServeMrr),
    currentSelfServeArrUsd: currentSelfServeMrr === null ? null : usd2(currentSelfServeMrr * ARR_MONTH_MULTIPLE),
    currentTotalMrrUsd: currentTotalMrr === null ? null : usd2(currentTotalMrr),
    currentTotalArrUsd: currentTotalMrr === null ? null : usd2(currentTotalMrr * ARR_MONTH_MULTIPLE),
    currentSelfServeBasis: currentSelfServeMrr === null ? null : self.basis,
    currentAgencyBudgetMrrUsd: usd2(agencyBudget.mrrUsd),
    earningRecordBeginsOn: inputs.earningRecordBeginsOn,
    agencyOrgIds: agencyOrgIdsOf(inputs.statedRows),
    agencyPairKeys: agencyKeys,
    monthly,
    weekly,
  };
}
