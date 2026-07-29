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
  // A real ratio needs BOTH real spend AND real outcomes. With 0 spend, `spent/count` would be a false
  // $0 even when outcomes exist (e.g. outcomes tracked but cost un-attributed) — so that case floors to
  // the parent, exactly like the 0-outcome case.
  if (spentUsd > 0 && observedCount > 0) return spentUsd / observedCount;
  return Math.max(spentUsd, parentCost ?? 0);
}

/**
 * FLOORED — the DISPLAY variant for a per-grain cost-per-outcome that a coarser grain can back-stop
 * (audience → brand). It is `projectedCostPerOutcome` with an honest `null` for a genuinely-empty cell:
 *
 *   - spend > 0 AND outcomes > 0 → the real OBSERVED ratio (spend / outcomes), UNCHANGED from observed.
 *   - otherwise                  → the cascade floor `max(spentUsd, parentCost)` — a 0-outcome grain
 *                                  with spend never looks artificially free, and never dips below the
 *                                  coarser grain's cost — BUT `null` when that floor is 0 (no spend AND
 *                                  no positive parent), so a cell with NOTHING to fall back on renders
 *                                  "-", never a false $0.
 *
 * A grain with NO spend and NO outcome is NOT a special case: it takes the same `max(spend, parent)` =
 * `parentCost` its already-started siblings floor to. An UNSTARTED audience and an audience that spent a
 * few cents are equally un-evidenced, so showing one the benchmark and the other "-" splits four equally
 * unstarted audiences into "three priced, one blank" — while the Strategy page (whose per-audience row
 * falls back to the best workflow's brand row for exactly these audiences) shows ALL of them the same
 * benchmark. The parent is that benchmark, not a fabrication; when there is no parent either, the floor
 * is 0 and the cell still renders "-".
 *
 * Use it for a RAW column ONLY — one whose driving outcome IS the outcome (cost per website visit, cost
 * per positive reply). There the spend floor is sound: "$23.16 spent, 0 clicks → a click costs at least
 * $23.16". A DERIVED funnel column (form submission / signup / sale) takes `derivedCostPerOutcome`
 * instead, because answering "cost per form submission" with a raw dollar total is a units error.
 *
 * The four engines, one per consumption:
 *   • observedCostPerOutcome  — null whenever an outcome is 0 (ACCOUNTING / real money).
 *   • projectedCostPerOutcome — NEVER null (RANKING — always a comparable number, even at 0 spend).
 *   • flooredCostPerOutcome   — floored when there is spend, null only for a truly-empty cell (DISPLAY,
 *                               RAW columns — a dashboard cost column that must show the brand-floored
 *                               estimate at 0 outcomes yet nothing at all for an untouched audience).
 *   • derivedCostPerOutcome   — DISPLAY, FUNNEL columns: the grain's own observed driving unit cost
 *                               carried through the brand's economics, never a raw dollar total.
 *
 * `parentCost` = the next COARSER grain's ALREADY-RESOLVED cost of the SAME type (audience → brand);
 * omit (or null) when the surface has no coarser grain → the floor degrades to own spend.
 */
export function flooredCostPerOutcome(
  spentUsd: number,
  observedCount: number,
  parentCost: number | null = null,
): number | null {
  // Real observed ratio when BOTH are present.
  if (spentUsd > 0 && observedCount > 0) return spentUsd / observedCount;
  // Cascade floor for EVERY un-evidenced cell — 0-outcome-with-spend, un-attributed-cost-with-outcomes,
  // AND the never-started cell (spend 0, outcomes 0), which floors to the parent benchmark exactly like
  // its barely-started siblings. Guard a 0 floor (nothing spent AND no positive parent) → null rather
  // than a false $0.
  const floor = Math.max(spentUsd, parentCost ?? 0);
  return floor > 0 ? floor : null;
}

/**
 * DERIVED — the DISPLAY variant for a FUNNEL column: a cost-per-outcome whose outcome is NOT its own
 * driving outcome but is reached THROUGH one (a website visit, a positive reply) at the brand's
 * conversion rate — cost per form submission, per signup, per sale.
 *
 * A raw dollar TOTAL is a legitimate lower bound only for a RAW column, where the driving outcome IS the
 * outcome. Applying the same spend floor to a DERIVED column is a units error: it answers "cost per form
 * submission" with a total spend, and it DISCARDS the clicks the grain did observe — even though every
 * other surface builds that column by pushing exactly those observed unit costs through the funnel. So a
 * derived column takes, in order:
 *
 *   1. spend > 0 AND outcomes > 0   → the real OBSERVED ratio (spend / outcomes), same as every engine.
 *   2. `funnelProjectionUsd`        → the funnel projection (`projectOutcomeCosts`) of the grain's
 *                                     RESOLVED driving unit cost — the grain's own observed evidence
 *                                     carried through the brand's economics. This is the evidence-grounded
 *                                     answer AND the number the projection surface resolves for the same
 *                                     grain, so the two surfaces agree by construction.
 *   3. otherwise (cold start — no economics, so no projection exists to be coherent with) → the cascade
 *      floor `max(spentUsd, parentCost)`, null when that floor is 0.
 *
 * A never-started grain (spend 0, outcomes 0) is NOT special-cased out: it takes the same brand-level
 * projection its barely-started siblings take, so equally-unstarted audiences are priced alike on both
 * surfaces. Only a grain with no projection AND no parent falls through to null.
 *
 * Preferring (3) does NOT lose the "already outspent the benchmark" protection: the driving unit cost fed
 * to `projectOutcomeCosts` is itself the cascade floor `max(own spend, parent)` when the grain observed 0
 * of the driving outcome, so a grain that burned money with nothing to show still carries its own (higher)
 * spend — expressed per outcome instead of as a raw total.
 */
export function derivedCostPerOutcome(
  spentUsd: number,
  observedCount: number,
  funnelProjectionUsd: number | null,
  parentCost: number | null = null,
): number | null {
  // Real observed ratio when BOTH are present.
  if (spentUsd > 0 && observedCount > 0) return spentUsd / observedCount;
  // Evidence-grounded funnel projection of this grain's resolved driving unit cost — including for a
  // never-started grain, which is priced like its equally-unstarted siblings rather than blanked.
  if (funnelProjectionUsd != null && funnelProjectionUsd > 0) return funnelProjectionUsd;
  // Cold start only: no economics → no funnel to project through. Degrade to the raw cascade floor.
  const floor = Math.max(spentUsd, parentCost ?? 0);
  return floor > 0 ? floor : null;
}
