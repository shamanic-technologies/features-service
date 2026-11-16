/**
 * The UNROUNDED cost per outcome of an expected catalogue funnel leg (`expectedFunnelEconomics`; the wire serves it to the
 * cent). A route priced off the served cents drifts from the funnel's own cost once a sub-cent cost is multiplied by
 * thousands of outcomes (EXPECTED-FLEET-RATE-1116: Wide Email's $0.067 per lead found is served $0.07, and 19,550 leads per
 * paying client at the fleet's 0.10 % read $2,368 on the spend chart beside the $2,311 its expected ROI divides). Off the
 * wire, like `expectedRouteOf`. PURE (module state is a WeakMap on the leg objects).
 */
const exact = new WeakMap<object, number>();

export function noteExactLegCost(leg: object, costPerOutcomeUsd: number): void {
  exact.set(leg, costPerOutcomeUsd);
}

/** The leg's unrounded cost when its builder noted one, else the served one. */
export function exactLegCostOf(leg: { costPerOutcomeUsd: number | null }): number | null {
  return exact.get(leg) ?? leg.costPerOutcomeUsd;
}
