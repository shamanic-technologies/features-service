/**
 * THE FLEET'S MONTHLY RUN-RATE, SPLIT IN TWO — because the two halves are earned on genuinely
 * different bases and adding them under one word states something that is not true of either.
 *
 * A SELF-SERVE (SaaS) customer pays THROUGH the product: what they are worth per month IS their daily
 * budget × 30, which this service already computes and has recorded daily since 2026-07-15. An AGENCY
 * does not: it hands over cash at its own discretion and somebody then DECIDES how that cash is split
 * into daily budgets across its brands. For those brands the daily budget is an ALLOCATION DECISION,
 * so budget × 30 answers "how did we spread their money this week", not "what is this customer worth".
 * The only true figure there is the one a human states in `stated_monthly_amounts`.
 *
 * The three series, and why they reconcile BY CONSTRUCTION:
 *
 *   AGENCY    = Σ of the STATED amounts in force on the period's reference date. NEVER those brands'
 *               budget × 30 — that substitution is the entire bug this exists to remove.
 *   SELF-SERVE= the fleet's recorded committed run-rate for that period MINUS the agency side's
 *               committed contribution on the same date. Their budget still exists and still belongs
 *               to the fleet's spend; it simply is not their MRR.
 *   TOTAL     = agency + self-serve, so the two halves always add to the number served beside them.
 *
 * WHICH ORGS ARE AGENCY IS DERIVED FROM THE STATED ROWS — an org carrying at least one stated amount
 * is agency, every other org is self-serve. No org id in code; a second agency later needs no change.
 * The exclusion is taken over the org's WHOLE (org, brand) set, not only its stated brands: a brand
 * funded under an agency org is agency money whether or not anyone has got round to stating it, and
 * leaving it in the self-serve half would overstate the SaaS business. When that happens the gap is
 * visible rather than silent — `agencyBudgetMrrUsd` says exactly how much left the self-serve half,
 * so a reader comparing it against `agencyMrrUsd` can see an unstated agency brand.
 *
 * HISTORY IS REPLAYED, NOT RECORDED. No daily snapshot ever carried the split (it did not exist), and
 * losing the history was never necessary: billing-service keeps an append-only per-(org, brand)
 * daily-budget timeline whose first row lands the SAME DAY as the first committed snapshot, so the
 * agency side's budget on any recorded day is readable. A day BEFORE that pair's first timeline entry
 * contributes 0 — we have no record of a budget then, and asserting one would be fabrication.
 *
 * THE ONE MEASUREMENT CAVEAT, stated rather than hidden: since 2026-08-27 the fleet snapshot records
 * the RUNNING daily budget (money behind an ongoing campaign) while billing's timeline records the
 * CONFIGURED one. For a brand whose campaign is ongoing the two agree, which is the case for every
 * funded agency brand today; for a brand with money posted against a stopped campaign the replayed
 * contribution is the larger of the two, so the self-serve half reads slightly low rather than
 * slightly high. The LIVE figures have no such gap — they subtract the accounts audit's own RUNNING
 * budget for the same active pairs, so today's self-serve cancels against today's committed MRR to
 * the cent.
 */
import { bucketOf, enumerateBuckets } from "./active-users-compute.js";
import { committedPointsByPeriod } from "./committed-mrr-compute.js";
import { MRR_DAY_MULTIPLE } from "./committed-mrr-store.js";
import { ARR_MONTH_MULTIPLE } from "./committed-mrr-compute.js";
import type { StatedAmountRow } from "./stated-monthly-amounts-store.js";
import type { BudgetChangeEntry } from "./history-clients.js";

/** Round a USD amount to 2 decimals, FP-safe. */
function usd2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Composite key for an (org, brand) pair — budgets and stated amounts are both keyed on the pair. */
export function pairKey(orgId: string, brandId: string): string {
  return `${orgId}::${brandId}`;
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
  /** The fleet's committed run-rate for the period MINUS the agency side's committed contribution, USD. */
  selfServeMrrUsd: number;
  /** Self-serve ARR = selfServeMrrUsd × 12, USD. */
  selfServeArrUsd: number;
  /** agencyMrrUsd + selfServeMrrUsd — the two halves are disjoint, so this is the honest fleet total. */
  totalMrrUsd: number;
  /** Total ARR = totalMrrUsd × 12, USD. */
  totalArrUsd: number;
  /**
   * What the agency side's BUDGET × 30 came to on `referenceDate` — i.e. exactly how much left the
   * self-serve half. Served so an unstated agency brand is visible: when this exceeds `agencyMrrUsd`,
   * some agency budget is in nobody's half and `totalMrrUsd` sits below the fleet committed figure.
   */
  agencyBudgetMrrUsd: number;
  /** The fleet committed run-rate this period was split from (`selfServeMrrUsd + agencyBudgetMrrUsd`), USD. */
  committedMrrUsd: number;
  /** Point-over-point growth of `totalMrrUsd` vs the previous EMITTED bucket, percent (1-decimal). null on the first or a 0 base. */
  growthPct: number | null;
}

export interface MrrSplit {
  /** LIVE agency MRR — Σ stated amounts in force today. */
  currentAgencyMrrUsd: number;
  currentAgencyArrUsd: number;
  /** LIVE self-serve MRR — the accounts-audit fleet MRR minus the agency side's ACTIVE running budget × 30. */
  currentSelfServeMrrUsd: number;
  currentSelfServeArrUsd: number;
  /** LIVE total = agency + self-serve. */
  currentTotalMrrUsd: number;
  currentTotalArrUsd: number;
  /** What the agency side contributed to the live committed MRR (their ACTIVE running budget × 30). */
  currentAgencyBudgetMrrUsd: number;
  /** The orgs the stated rows identify as agency — derived, never hardcoded. Sorted, for a stable body. */
  agencyOrgIds: string[];
  /** Every (org, brand) pair excluded from the self-serve half, as `orgId::brandId`. Sorted. */
  agencyPairKeys: string[];
  monthly: MrrSplitBucket[];
  weekly: MrrSplitBucket[];
}

/**
 * The pair's CONFIGURED daily budget as of a UTC day, replayed from billing's append-only timeline:
 * the value carried by the LAST entry whose change day is on or before `day`. A day before the first
 * entry answers 0 — we hold no record of a budget then, and inventing one would be fabrication.
 * Entries are oldest-first, so several changes on one day collapse to that day's final value. Pure.
 */
export function budgetUsdOn(timeline: BudgetChangeEntry[], day: string): number {
  let value = 0;
  for (const entry of timeline) {
    if (entry.changedAt.slice(0, 10) > day) break;
    value = entry.dailyBudgetUsd;
  }
  return value;
}

/**
 * Is a stated row in force on `day`? Both bounds are INCLUSIVE. A null `endDate` is "still running".
 * A null `startDate` is "since this brand's FIRST DAY OF BILLED SPEND" — so it needs that day, which
 * the caller supplies per pair; when the brand has never billed a day there is no lower bound to
 * apply, and the row is in force from the start rather than silently never counted. Pure.
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

/** Σ over the agency pairs of their replayed configured budget × 30 on `day`, USD. Pure. */
export function agencyBudgetMrrOn(
  agencyPairKeys: string[],
  timelines: Map<string, BudgetChangeEntry[]>,
  day: string,
): number {
  let total = 0;
  for (const key of agencyPairKeys) {
    total += budgetUsdOn(timelines.get(key) ?? [], day) * MRR_DAY_MULTIPLE;
  }
  return total;
}

export interface MrrSplitInputs {
  /** Every stated monthly amount on record (all pairs, all ranges). Empty ⇒ the fleet is entirely self-serve. */
  statedRows: StatedAmountRow[];
  /** Every cold-email (org, brand) pair, from the accounts audit — the universe the agency set is drawn from. */
  allPairs: Array<{ orgId: string; brandId: string }>;
  /** Replayed daily-budget timelines per agency pair key (billing's append-only history). */
  budgetTimelines: Map<string, BudgetChangeEntry[]>;
  /** First UTC day of billed spend per pair key — the floor for a stated row with no start. null = never billed. */
  firstBilledDayByPair: Map<string, string | null>;
  /** Recorded committed snapshots (date → fleet committed MRR, USD), oldest→newest. */
  snapshots: Array<{ date: string; mrrUsd: number }>;
  /** The LIVE fleet committed MRR (accounts-audit Σ ACTIVE running budget × 30). */
  currentMrrUsd: number;
  /** The agency side's share of that live figure — Σ of its ACTIVE pairs' running budget × 30. */
  currentAgencyBudgetMrrUsd: number;
}

/** The agency orgs, derived: any org carrying at least one stated amount, whatever its date range. Pure. */
export function agencyOrgIdsOf(statedRows: StatedAmountRow[]): string[] {
  return [...new Set(statedRows.map((r) => r.orgId))].sort();
}

/**
 * Every (org, brand) pair whose org is on the agency side — the set excluded from the self-serve half.
 * Drawn from the WHOLE cold-email pair universe, so an agency brand nobody has stated an amount for
 * still leaves the SaaS figure. Pure.
 */
export function agencyPairKeysOf(statedRows: StatedAmountRow[], allPairs: Array<{ orgId: string; brandId: string }>): string[] {
  const agencyOrgs = new Set(agencyOrgIdsOf(statedRows));
  const keys = new Set<string>();
  for (const p of allPairs) {
    if (agencyOrgs.has(p.orgId)) keys.add(pairKey(p.orgId, p.brandId));
  }
  // A stated pair is agency by definition, even if the membership read has not caught up to it.
  for (const r of statedRows) keys.add(pairKey(r.orgId, r.brandId));
  return [...keys].sort();
}

/** Build one granularity's split series over the periods the committed series emits. Pure. */
function buildSeries(
  inputs: MrrSplitInputs,
  agencyPairKeys: string[],
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
    // The CURRENT period reads the live agency contribution (running budget, the same basis the live
    // committed MRR is built on) so today's self-serve cancels to the cent; past periods replay the
    // configured timeline, the only record that reaches back.
    const agencyBudgetMrr =
      day === todayIso
        ? inputs.currentAgencyBudgetMrrUsd
        : agencyBudgetMrrOn(agencyPairKeys, inputs.budgetTimelines, day);
    const selfServeMrr = point.mrrUsd - agencyBudgetMrr;
    const totalMrr = agencyMrr + selfServeMrr;

    const prev = emitted.length ? emitted[emitted.length - 1].totalMrrUsd : null;
    const growthPct = prev !== null && prev > 0 ? Math.round(((totalMrr - prev) / prev) * 1000) / 10 : null;

    emitted.push({
      period: b.period,
      periodStart: b.periodStart,
      referenceDate: day,
      agencyMrrUsd: usd2(agencyMrr),
      agencyArrUsd: usd2(agencyMrr * ARR_MONTH_MULTIPLE),
      selfServeMrrUsd: usd2(selfServeMrr),
      selfServeArrUsd: usd2(selfServeMrr * ARR_MONTH_MULTIPLE),
      totalMrrUsd: usd2(totalMrr),
      totalArrUsd: usd2(totalMrr * ARR_MONTH_MULTIPLE),
      agencyBudgetMrrUsd: usd2(agencyBudgetMrr),
      committedMrrUsd: usd2(point.mrrUsd),
      growthPct,
    });
  }
  return emitted;
}

/**
 * Build the whole agency / self-serve / total split — live figures plus the monthly and weekly history,
 * over exactly the periods the committed series already emits (never a fabricated point for a day no
 * snapshot recorded). Pure; every read the history needs is done by the caller.
 */
export function buildMrrSplit(
  inputs: MrrSplitInputs,
  now: Date,
  windows: { weeks: number; months: number },
): MrrSplit {
  const todayIso = now.toISOString().slice(0, 10);
  const agencyPairKeys = agencyPairKeysOf(inputs.statedRows, inputs.allPairs);

  const currentAgencyMrr = agencyStatedMrrOn(inputs.statedRows, todayIso, inputs.firstBilledDayByPair);
  const currentSelfServeMrr = inputs.currentMrrUsd - inputs.currentAgencyBudgetMrrUsd;
  const currentTotalMrr = currentAgencyMrr + currentSelfServeMrr;

  return {
    currentAgencyMrrUsd: usd2(currentAgencyMrr),
    currentAgencyArrUsd: usd2(currentAgencyMrr * ARR_MONTH_MULTIPLE),
    currentSelfServeMrrUsd: usd2(currentSelfServeMrr),
    currentSelfServeArrUsd: usd2(currentSelfServeMrr * ARR_MONTH_MULTIPLE),
    currentTotalMrrUsd: usd2(currentTotalMrr),
    currentTotalArrUsd: usd2(currentTotalMrr * ARR_MONTH_MULTIPLE),
    currentAgencyBudgetMrrUsd: usd2(inputs.currentAgencyBudgetMrrUsd),
    agencyOrgIds: agencyOrgIdsOf(inputs.statedRows),
    agencyPairKeys,
    monthly: buildSeries(inputs, agencyPairKeys, enumerateBuckets(todayIso, "month", windows.months), "month", todayIso),
    weekly: buildSeries(inputs, agencyPairKeys, enumerateBuckets(todayIso, "week", windows.weeks), "week", todayIso),
  };
}
