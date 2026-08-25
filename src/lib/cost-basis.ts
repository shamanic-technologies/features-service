/**
 * CHARGED vs INCURRED — the ACCOUNTING / PERFORMANCE axis on run spend.
 *
 * The platform sometimes COMPS a customer for spend that genuinely happened (a provider incident
 * burned their budget producing nothing). runs-service records that as its own cost state: the money
 * left the building, and we decided not to charge it. This service answers TWO different questions
 * off that one ledger, and they want opposite treatment of a comped cost:
 *
 *   - CHARGED (accounting) — what the customer was CHARGED. Their spend, their invested total, their
 *     ROI, their %CAC, their cost per outcome. A comped cost must VANISH from these: they did not pay
 *     it. This is the default everywhere, and it is what falls out of runs-service on its own — its
 *     aggregation predicates are `status IN ('actual','provisioned')`, so a refunded row simply is not
 *     in `totalCostInUsdCents`.
 *
 *   - INCURRED (performance) — what a workflow actually COSTS to produce an outcome. The cross-org
 *     fleet benchmark that ranks workflows, and every projection of what a budget buys. A comped cost
 *     must STAY here at FULL value: dropping it makes the comped brand look artificially cheap, drags
 *     the fleet benchmark down for every other customer, and under-prices what their budget buys.
 *     Nothing errors when this goes wrong — the spend just disappears — which is exactly why the
 *     basis is named on every read rather than inferred.
 *
 * THIS IS NOT THE GROSS/NET AXIS. Gross-vs-net (`pricing.ts`) is a DISCOUNT question: what did we
 * charge versus list price. Charged-vs-incurred is a COMPED question: did we charge it at all. They
 * COMPOSE — a NET INCURRED figure is the discounted price of spend we comped — and neither may be
 * folded into the other.
 *
 * WHERE THE REFUND BUCKET COMES FROM. runs-service owns the shape; this service only reads it. Its
 * deployed cost aggregations name every state as `<state>CostInUsdCents` with a frozen-net twin
 * `net<State>CostInUsdCents` (`total`/`actual`/`provisioned`/`cancelled` today), so the refunded
 * bucket is read under that same convention. It is OPTIONAL on purpose: while the producer has not
 * deployed its side the field is simply absent, every read contributes ZERO refunded cents, and both
 * bases are byte-identical to today. The value fills in on its own the moment runs deploys, with no
 * change here. Do NOT make it required, and do NOT fabricate one from another field.
 */

import type { Pricing } from "./pricing.js";

export type CostBasis = "charged" | "incurred";

/** The runs-service refunded bucket, under the producer's own `<state>CostInUsdCents` convention. */
export const REFUNDED_GROSS_FIELD = "refundedCostInUsdCents";
/** Its frozen-net twin, under the producer's own `net<State>CostInUsdCents` convention. */
export const REFUNDED_NET_FIELD = "netRefundedCostInUsdCents";

/** Parse the `?basis=` / `?costBasis=` shape. Absent → "charged" (the default). null = unrecognised. */
export function parseCostBasis(raw: unknown): CostBasis | null {
  if (raw === undefined || raw === null || raw === "") return "charged";
  if (raw === "charged" || raw === "incurred") return raw;
  return null;
}

/**
 * The refunded (comped) cents on one runs-service cost group or dated bucket, on the requested
 * pricing basis. ABSENT / non-numeric ⇒ **0** — the producer has not shipped the bucket yet, or this
 * group has nothing comped, and both are the same statement: nothing to add back.
 *
 * On NET, the frozen `netRefunded…` twin is preferred and the gross refunded figure is the fallback —
 * the SAME `COALESCE(net, gross)` runs-service applies to pre-freeze rows. That fallback is safe here
 * in a way a gross fallback on a customer PRICE would not be: this figure is only ever ADDED to a
 * performance benchmark, so the worst case slightly OVERSTATES what a workflow costs, which
 * under-promises rather than over-promises what a budget buys.
 */
export function refundedCents(group: object, pricing: Pricing): number {
  const row = group as Record<string, unknown>;
  const raw = pricing === "net" ? (row[REFUNDED_NET_FIELD] ?? row[REFUNDED_GROSS_FIELD]) : row[REFUNDED_GROSS_FIELD];
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
