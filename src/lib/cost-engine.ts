/**
 * cost-engine — the SINGLE shared source of truth for "cost per outcome" across every stats surface.
 *
 * Two named engines, ONE per accounting philosophy. An endpoint picks EXACTLY ONE; it never hand-rolls
 * a `spent / count` ratio inline. Homogeneous by construction: the same 0-outcome decision runs
 * everywhere the engine is called.
 *
 *   ┌─ observedCostPerOutcome ── "what actually happened" (ACCOUNTING / real spend).
 *   │    0 outcomes → null (renders "-"). NEVER fabricates a number that wasn't measured.
 *   │    Use for: real-money / bookkeeping surfaces (the /revenue `spend` block, any future
 *   │    dedicated "real cost" endpoint). These fields carry accounting names (`spent`, `actual`).
 *   │
 *   └─ projectedCostPerOutcome ── "rankable estimate" (the DEFAULT everywhere: dashboard, ranking,
 *        recommendation). 0 outcomes → floor to `max(spentUsd, parentCost)`, so a grain that has
 *        already burned money with nothing to show never looks artificially free. NEVER null when
 *        there is spend — a rankable surface must always produce a comparable number.
 *
 * DEFAULT RULE (product): projection is the default for the dashboard and everywhere, EXCEPT
 * accounting (real spend / bookkeeping), which takes observed. If the front wants raw observed cost
 * on a projection surface, that is a dedicated observed endpoint — not a flag on this one.
 *
 * The parent-cascade (projected) — a grain floors against the next COARSER grain's cost, iteratively:
 *   crossOrg (fleet, no parent) → brand → audience.
 * Rationale: with 0 observed outcomes the true cost-per-outcome is unknown but is AT LEAST the spend
 * so far; the coarser grain's cost is the prior estimate. So:
 *   - spent < parentCost  → not yet proven worse than the parent → assume the parent's cost.
 *   - spent > parentCost  → already spent more than the parent's rate with 0 outcomes → the grain's
 *                           own spend is the (higher) conservative floor.
 * A surface with no grain ladder (brand-only) passes no parent → the floor degrades to the grain's
 * own spend (`max(spentUsd, 0)`), the base case of the same cascade.
 */

/**
 * OBSERVED — real cost per outcome. `null` when there is no attributed spend OR no outcome observed
 * (renders "-", never a false $0). "What actually happened" — for accounting / real-spend surfaces.
 */
export function observedCostPerOutcome(spentUsd: number, observedCount: number): number | null {
  return spentUsd > 0 && observedCount > 0 ? spentUsd / observedCount : null;
}

/**
 * PROJECTED — rankable cost per outcome (the DEFAULT). A real ratio when `observedCount > 0`; else the
 * cascade floor `max(spentUsd, parentCost)`. Never null (a rankable surface always yields a number at
 * any spend). `parentCost` = the next coarser grain's ALREADY-RESOLVED cost of the SAME type
 * (crossOrg→brand→audience); omit (or null) when the surface has no coarser grain → floor to own spend.
 */
export function projectedCostPerOutcome(
  spentUsd: number,
  observedCount: number,
  parentCost: number | null = null,
): number {
  if (observedCount > 0) return spentUsd / observedCount;
  return Math.max(spentUsd, parentCost ?? 0);
}
