/**
 * EVERY RATIO ON A REVENUE BODY DIVIDES ONE BASIS — the one the ROI divides.
 *
 * The ROI is measured on the MATURE COHORT (`lib/roi-maturity.ts`): spend old enough to have produced
 * its outcomes, over the leads that spend reached. Until 2026-09-26 only the ROI, %CAC and $CAC did;
 * every cost per outcome on the same body (the spend block's cost per click / positive reply / signup
 * / meeting / form / sale, `outcomes.cpcCents`, the funnel rungs' cost per reach and the
 * cost-per-outcome curve) divided the WHOLE history's spend by the whole history's outcomes. So one
 * screen charged the client for the last fortnight of sending whose replies had not arrived yet, while
 * the ROI beside it had excluded exactly that spend. Measured in prod (Doc Dinners, net): cost per
 * positive reply $211.67 on the whole history ($5,503 / 26) against ~$173 on the ROI's own cohort
 * ($3,984 / 23) — the number the client reads most, biased ~18% against us.
 *
 * Every ratio now reads THIS basis, and every body states it beside the ratio (`ratioBasis`), so a
 * reader reconciles each ratio from served totals instead of inverting it.
 *
 *   - `whole`   — nothing in scope waits for its outcomes (every leg matures on the day it is bought):
 *                 the ratios divide the whole scope, byte-identical to before.
 *   - `mature`  — the mature cohort: its committed spend (runs started before the cutoff, plus the
 *                 zero-delay campaigns' later runs) and its persons (leads first contacted before the
 *                 cutoff, undated leads included). When that spend is 0 while the scope has spent, the
 *                 scope is `maturing` and every ratio reads null — never 0, never the whole history.
 *   - `unknown` — campaign-service could not name the scope's legs, so young and mature spend cannot
 *                 be told apart: every ratio reads null with `maturity_unknown`, exactly as the ROI does.
 *
 * TOTALS NEVER MOVE: invested, spent today, headline pipeline, every count and every series keep the
 * whole history. Only the ratios — and the `ratioBasis` block stating what they divide — use this.
 */
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import type { RunsCostCents } from "./runs-cost-client.js";
import type { MaturityReason } from "./cost-economics.js";

export type RatioBasis =
  | { kind: "whole" }
  | { kind: "mature"; days: number; cost: RunsCostCents; persons: EnginePerson[] }
  | { kind: "unknown" };

export const WHOLE_BASIS: RatioBasis = { kind: "whole" };

/** The days the basis waited, as stated on the wire (0 when nothing waits or the legs are unknown). */
export function basisDays(basis: RatioBasis | undefined): number {
  return basis?.kind === "mature" ? basis.days : 0;
}

/**
 * Why every ratio on this basis reads null, when a reason other than "nothing to divide" applies.
 * `maturing`: the scope spent, and none of it is old enough yet. Same rule `buildCostEconomics` applies.
 */
export function basisUnmeasuredReason(basis: RatioBasis | undefined, whole: RunsCostCents): MaturityReason | null {
  if (!basis || basis.kind === "whole") return null;
  if (basis.kind === "unknown") return "maturity_unknown";
  return basis.days > 0 && basis.cost.committedCents <= 0 && whole.committedCents > 0 ? "maturing" : null;
}

/** The spend the ratios divide. Null when the ratios cannot be measured at all (unknown / maturing). */
export function basisCost(basis: RatioBasis | undefined, whole: RunsCostCents): RunsCostCents | null {
  if (basisUnmeasuredReason(basis, whole) !== null) return null;
  return basis?.kind === "mature" ? basis.cost : whole;
}

/** The persons the ratios count. Null when the ratios cannot be measured at all. */
export function basisPersons(
  basis: RatioBasis | undefined,
  whole: RunsCostCents,
  persons: EnginePerson[],
): EnginePerson[] | null {
  if (basisUnmeasuredReason(basis, whole) !== null) return null;
  return basis?.kind === "mature" ? basis.persons : persons;
}

/**
 * PURE. The deals CLOSED WON among `persons`, and what they are worth — the numerator of the measured
 * return. A won deal counts when it is PRICED to our outreach (not in `unpricedSignals`) and not ruled
 * dead, the byte-same predicate the engine's won rung prices on, so the measured return and the
 * pipeline agree about which sales were ours. Valued like the engine values the terminal rung: the
 * amount stated on the lead, else the lifetime revenue a paying client is priced at.
 *
 * Null when a won deal carries no amount and no lifetime revenue is declared — it happened, and we
 * cannot say what it was worth, which is not the same as $0.
 */
export function closedWonOf(
  persons: EnginePerson[],
  lifetimeRevenueUsd: number | null | undefined,
): { closedWonCount: number; closedWonRevenueUsd: number } | null {
  let closedWonCount = 0;
  let closedWonRevenueUsd = 0;
  for (const p of dedupPersonsByLead(persons)) {
    if (!p.signals.closeWin) continue;
    if ((p.unpricedSignals ?? []).includes("closeWin")) continue;
    if ((p.deadSignals ?? []).includes("closeWin")) continue;
    const stated =
      typeof p.valueUsd === "number" && Number.isFinite(p.valueUsd) && p.valueUsd >= 0 ? p.valueUsd : null;
    const value = stated ?? (lifetimeRevenueUsd != null && lifetimeRevenueUsd > 0 ? lifetimeRevenueUsd : null);
    if (value === null) return null;
    closedWonCount += 1;
    closedWonRevenueUsd += value;
  }
  return { closedWonCount, closedWonRevenueUsd };
}
