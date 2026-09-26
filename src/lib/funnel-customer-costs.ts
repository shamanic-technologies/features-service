/**
 * THE CUSTOMER'S OWN MONEY, PARTITIONED BY FUNNEL STEP — pure, so the network read stays in the route.
 *
 * A statement is made on a lead row, which belongs to a CAMPAIGN, so the same campaign set that scopes
 * a read's charged spend scopes the customer's declared spend too, with nothing inferred.
 *
 * A STATED ZERO IS AN ANSWER; AN UNSTATED LEG IS NOT. `costCents: null` means nobody was ever asked,
 * so it contributes nothing to the sum and increments `unstatedCount` instead — which is how a
 * consumer knows the sum is incomplete. Fabricating a figure for it would be exactly the invented
 * number every other surface here refuses.
 */

/** What the customer says one scope's own legs cost them. Cents, to match the producer. */
export interface CustomerDeclaredCost {
  /** The sum of every STATED cost in this scope, in cents. Rows nobody answered contribute nothing. */
  costCents: number;
  /** How many statements carried a cost (0 included — a stated zero is an answer). */
  statedCount: number;
  /** How many did not, because nobody was ever asked. > 0 means this scope cannot be fully costed. */
  unstatedCount: number;
}

/**
 * Which dollars a figure is made of. The wire marker that keeps the stated basis TRUE, per row and for
 * the response as a whole.
 *
 *   platform_spend_only                  — no statement is attributable to this scope. Today's answer.
 *   platform_and_customer_spend          — every attributable statement carries a cost. Whole.
 *   platform_and_partial_customer_spend  — some legs were never stated, so the customer half is a
 *                                          floor rather than a total. A scope we cannot fully cost
 *                                          says so instead of guessing at the rest.
 */
export type FunnelCostCoverage =
  | "platform_spend_only"
  | "platform_and_customer_spend"
  | "platform_and_partial_customer_spend";

export function coverageOf(cost: CustomerDeclaredCost | null): FunnelCostCoverage {
  if (!cost || (cost.statedCount === 0 && cost.unstatedCount === 0)) return "platform_spend_only";
  return cost.unstatedCount > 0 ? "platform_and_partial_customer_spend" : "platform_and_customer_spend";
}

const EMPTY: CustomerDeclaredCost = { costCents: 0, statedCount: 0, unstatedCount: 0 };

/** One statement, reduced to the two things this partition needs. */
export interface AttributableCost {
  campaignId: string | null;
  costCents: number | null;
}

/**
 * PURE: what the customer states EACH STEP of a scope cost them, keyed by the producer's step word.
 *
 * The funnel-wide total answers "what did I spend on this funnel"; it cannot answer "what does a
 * booked meeting cost me", because the same total covers every rung of the chain at once. A statement
 * already NAMES the step it was made on, so the per-rung answer is a partition of the same rows — no
 * second producer, no inference, and the funnel-wide figure is byte-unchanged beside it.
 *
 * `campaignIds` SCOPES the statements exactly as the money above them is scoped: a campaign-narrowed
 * read counts only the statements made on its own campaigns, so the stated money and the committed
 * cents describe the same work. `null` means the read is the whole brand's — its committed spend is
 * the brand's whole spend, so its counterpart is every statement the brand has made. A statement
 * naming NO campaign cannot be placed inside a narrowed scope, so it is left out of one rather than
 * parked on a rung nobody attributed it to.
 */
export function customerCostsByStep(
  costs: Array<AttributableCost & { step: string }>,
  campaignIds: readonly string[] | null,
): Record<string, CustomerDeclaredCost> {
  const scope = campaignIds ? new Set(campaignIds) : null;
  const byStep: Record<string, CustomerDeclaredCost> = {};

  for (const cost of costs) {
    if (scope && (cost.campaignId === null || !scope.has(cost.campaignId))) continue;
    const bucket = (byStep[cost.step] ??= { ...EMPTY });
    if (cost.costCents === null) bucket.unstatedCount += 1;
    else {
      bucket.costCents += cost.costCents;
      bucket.statedCount += 1;
    }
  }
  return byStep;
}
