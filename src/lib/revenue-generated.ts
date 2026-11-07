/**
 * REVENUE GENERATED, REAL FIRST, EXPECTED SECOND (owner 2026-11-07, REVENUE-GENERATED-1107: « j'avais demandé que le
 * principal chiffre soit le réel revenu généré, et seulement secondaire est le expected. Idem avec la curve solid or
 * dotted. »), served on `/offers/:offerId/revenue` as `revenueGenerated`, beside the ROI tile's two returns.
 *
 * REAL = money actually won: the realized return's numerator, deal for deal (`closedWonDealsOf`, the byte-same
 * predicate and values as `costEconomics.realizedReturn`), each placed on the day it was won (`signalDates.closeWin`;
 * an undated sale lands on the first day so the series still ends at the total). So "0 paid clients" and $0 agree.
 *
 * EXPECTED = ONE basis, the expected return served beside it (`expectedReturn.roiMultiple`): what the spend is
 * expected to bring back. `expectedToDateUsd` = expected ROI × the realized return's `spentUsd`, so
 * expectedToDateUsd ÷ spentUsd IS the expected ROI on the same screen, by construction. Each past day reads
 * expected ROI × the spend committed up to that day (the body's dated committed spend, scaled onto `spentUsd` so
 * today's point equals `expectedToDateUsd` to the cent); the days after today add expected ROI × the offer's spend
 * pace since inception (spentUsd ÷ days from the first day to today, both counted), flat when nothing of the offer
 * runs. Never the Deals board's pipeline (a second value model: ONE basis, and a pipeline is no return's numerator,
 * ROI-CONSISTENCY-1103). PURE.
 */
import type { ClosedWonDeal } from "./ratio-basis.js";

/** How far the expected (dotted) continuation runs past today. */
export const REVENUE_EXPECTED_HORIZON_DAYS = 30;

export type RevenueRealUnavailableReason = "closed_deals_not_read" | "outcome_not_declared_in_ledger" | "no_producer_declares_outcome" | "ledger_unreadable" | "lifetime_revenue_not_stated";

/**
 * PURE. LEDGER-ONLY-1107: the REAL half re-based on the ledger's Paid client Units of the brand (`paid`, null = ledger
 * unreadable): count = Units, real $ = Units × the offer's lifetime revenue, per day off the Units' dates. The ledger
 * lacking Paid client Units = every real figure null + the ledger's reason, never the CRM's deals. The expected half
 * (expected ROI × the same spend) is untouched.
 */
export function withLedgerRealHalf(
  rg: RevenueGenerated,
  // LEDGER-OTHER-FACTORY-1107: revenue WE generated = OUR Paid client Units only (another factory's are no revenue of ours).
  paid: { units: number | null; ourUnits: number | null; unitsUnavailableReason: string | null; past: ReadonlyArray<{ date: string; ourUnits: number; cumulativeOurUnits: number }> } | null,
  lifetimeRevenueUsd: number | null,
): RevenueGenerated {
  const reason: RevenueRealUnavailableReason | null =
    paid === null ? "ledger_unreadable" : paid.units === null ? (paid.unitsUnavailableReason as RevenueRealUnavailableReason) : lifetimeRevenueUsd === null ? "lifetime_revenue_not_stated" : null;
  if (reason !== null || paid === null || paid.ourUnits === null || lifetimeRevenueUsd === null) {
    return { ...rg, realUsd: null, paidClientCount: null, realUnavailableReason: reason, undatedRealUsd: null, points: rg.points.map((p) => ({ ...p, realUsd: null, realCumulativeUsd: null })) };
  }
  const ltr = lifetimeRevenueUsd;
  const units = paid.ourUnits;
  const cumAt = (day: string) => {
    let v = 0;
    for (const p of paid.past) {
      if (p.date > day) break;
      v = p.cumulativeOurUnits;
    }
    return v;
  };
  const firstPoint = rg.points.find((p) => p.kind === "measured")?.date ?? null;
  return {
    ...rg,
    realUsd: round(units * ltr),
    paidClientCount: units,
    realUnavailableReason: null,
    undatedRealUsd: 0,
    points: rg.points.map((p) =>
      p.kind !== "measured"
        ? { ...p, realUsd: null, realCumulativeUsd: null }
        : {
            ...p,
            // Units dated before the chart's first day land on it, so the curve still ends at the total.
            realUsd: round(((paid.past.find((x) => x.date === p.date)?.ourUnits ?? 0) + (p.date === firstPoint ? cumAt(addDays(p.date, -1)) : 0)) * ltr),
            realCumulativeUsd: round(cumAt(p.date) * ltr),
          },
    ),
  };
}
export type RevenueExpectedUnavailableReason = "expected_return_unavailable" | "nothing_spent_yet";
export type RevenueExpectedFlatReason = "offer_not_running" | "offer_status_unreadable" | "spend_not_dated";

export interface RevenueGeneratedPoint {
  date: string;
  /** `measured` up to today (included), `expected` after. */
  kind: "measured" | "expected";
  /** Money won that day (real). Null on expected days or when the real figure is unavailable. */
  realUsd: number | null;
  /** Real revenue won up to that day (solid line). Null on expected days or when unavailable. */
  realCumulativeUsd: number | null;
  /** Expected revenue up to that day, on the expected return's basis (dotted line). Null when no expected figure. */
  expectedCumulativeUsd: number | null;
}

export interface RevenueGenerated {
  realUsd: number | null;
  paidClientCount: number | null;
  realUnavailableReason: RevenueRealUnavailableReason | null;
  undatedRealUsd: number | null;
  spentUsd: number;
  expectedToDateUsd: number | null;
  expectedUsd: number | null;
  expectedUnavailableReason: RevenueExpectedUnavailableReason | null;
  expectedHorizonDays: number;
  dailySpendPaceUsd: number | null;
  expectedFlatReason: RevenueExpectedFlatReason | null;
  offerRunning: boolean | null;
  firstDay: string | null;
  today: string;
  points: RevenueGeneratedPoint[];
}

const round = (n: number): number => Math.round(n * 100) / 100;
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayOf = (iso: string | null): string | null => {
  const d = iso?.slice(0, 10) ?? null;
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

export function buildRevenueGenerated(input: {
  /** `closedWonDealsOf` on the body's persons; null = no closed-deal source was read (realizedReturn null). */
  deals: readonly ClosedWonDeal[] | null;
  /** The realized return's `spentUsd` (actual spend, whole history): the ROI tile's spend. */
  spentUsd: number;
  /** The body's dated COMMITTED spend (YYYY-MM-DD → USD that day); null when the dated read degraded. */
  spendByDay: ReadonlyMap<string, number> | null;
  /** `expectedReturn.roiMultiple` served beside it; null when the expected return is unavailable. */
  expectedRoiMultiple: number | null;
  /** A campaign of the offer is running now; null = campaign-service unreadable. */
  offerRunning: boolean | null;
  today: string;
  horizonDays?: number;
}): RevenueGenerated {
  const horizon = input.horizonDays ?? REVENUE_EXPECTED_HORIZON_DAYS;
  const today = input.today;

  // REAL, by won day.
  const wonByDay = new Map<string, number>();
  let undated = 0;
  for (const d of input.deals ?? []) {
    const day = dayOf(d.wonAt);
    if (day === null) undated += d.valueUsd;
    else {
      const at = day > today ? today : day;
      wonByDay.set(at, (wonByDay.get(at) ?? 0) + d.valueUsd);
    }
  }
  const realTotal = input.deals === null ? null : input.deals.reduce((s, d) => s + d.valueUsd, 0);

  // Dated spend, days after today folded onto today.
  const spendDays = new Map<string, number>();
  for (const [day, usd] of input.spendByDay ?? []) {
    if (!(usd !== 0) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const at = day > today ? today : day;
    spendDays.set(at, (spendDays.get(at) ?? 0) + usd);
  }
  const committedTotal = [...spendDays.values()].reduce((s, v) => s + v, 0);

  const starts = [...wonByDay.keys(), ...spendDays.keys()].sort();
  const firstDay = starts[0] ?? (undated > 0 || input.spentUsd > 0 ? today : null);

  const roi = input.expectedRoiMultiple !== null && Number.isFinite(input.expectedRoiMultiple) ? input.expectedRoiMultiple : null;
  const expectedUnavailableReason: RevenueExpectedUnavailableReason | null =
    roi === null ? "expected_return_unavailable" : !(input.spentUsd > 0) ? "nothing_spent_yet" : null;
  const expectedToDate = expectedUnavailableReason === null ? input.spentUsd * roi! : null;
  // Past days: expected ROI × the spend committed by then, scaled onto the actual spend so today = expectedToDate.
  const scale = committedTotal > 0 ? input.spentUsd / committedTotal : null;
  const pastExpected = expectedToDate !== null && input.spendByDay !== null && scale !== null;

  const points: RevenueGeneratedPoint[] = [];
  let realCum = 0;
  let spendCum = 0;
  let elapsed = 0;
  if (firstDay !== null) {
    for (let d = firstDay, i = 0; d <= today; d = addDays(d, 1), i += 1) {
      const won = (wonByDay.get(d) ?? 0) + (i === 0 ? undated : 0);
      realCum += won;
      spendCum += spendDays.get(d) ?? 0;
      elapsed += 1;
      const isToday = d === today;
      points.push({
        date: d,
        kind: "measured",
        realUsd: realTotal === null ? null : round(won),
        realCumulativeUsd: realTotal === null ? null : round(isToday ? realTotal : realCum),
        expectedCumulativeUsd:
          expectedToDate === null ? null : isToday ? round(expectedToDate) : pastExpected ? round(roi! * spendCum * scale!) : null,
      });
    }
  }

  const pace = elapsed > 0 && input.spentUsd > 0 ? input.spentUsd / elapsed : null;
  const flat: RevenueExpectedFlatReason | null =
    expectedToDate === null
      ? null
      : input.offerRunning === null
        ? "offer_status_unreadable"
        : !input.offerRunning
          ? "offer_not_running"
          : pace === null ? "spend_not_dated" : null;
  const step = expectedToDate !== null && flat === null ? roi! * pace! : 0;
  if (firstDay !== null) {
    for (let k = 1; k <= horizon; k += 1) {
      points.push({
        date: addDays(today, k),
        kind: "expected",
        realUsd: null,
        realCumulativeUsd: null,
        expectedCumulativeUsd: expectedToDate === null ? null : round(expectedToDate + step * k),
      });
    }
  }

  return {
    realUsd: realTotal === null ? null : round(realTotal),
    paidClientCount: input.deals === null ? null : input.deals.length,
    realUnavailableReason: input.deals === null ? "closed_deals_not_read" : null,
    undatedRealUsd: realTotal === null ? null : round(undated),
    spentUsd: round(input.spentUsd),
    expectedToDateUsd: expectedToDate === null ? null : round(expectedToDate),
    expectedUsd: expectedToDate === null ? null : round(expectedToDate + step * horizon),
    expectedUnavailableReason,
    expectedHorizonDays: horizon,
    dailySpendPaceUsd: pace === null ? null : round(pace),
    expectedFlatReason: flat,
    offerRunning: input.offerRunning,
    firstDay,
    today,
    points,
  };
}
