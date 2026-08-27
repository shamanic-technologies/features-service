/**
 * THE CUSTOMER'S OWN MONEY, PARTITIONED BY SALES CHAIN — pure, so the network read stays in the route.
 *
 * A statement is made on a lead row, which belongs to a CAMPAIGN, and a campaign states exactly one
 * chain. So the same campaign set that scopes a chain's charged spend scopes the customer's declared
 * spend too, with nothing counted twice and nothing inferred: a statement is in the row whose campaign
 * set contains its campaign, and in no other.
 *
 * A statement we cannot place — no campaign named, or a campaign belonging to no chain of this offer
 * (another offer's, or one stating no chain) — is NOT dropped in silence and NOT parked on a default.
 * It is reported apart, exactly as an unattributed campaign id already is, so a reader sees the
 * difference rather than wondering why the rows do not add up.
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
export type ChainCostCoverage =
  | "platform_spend_only"
  | "platform_and_customer_spend"
  | "platform_and_partial_customer_spend";

export function coverageOf(cost: CustomerDeclaredCost | null): ChainCostCoverage {
  if (!cost || (cost.statedCount === 0 && cost.unstatedCount === 0)) return "platform_spend_only";
  return cost.unstatedCount > 0 ? "platform_and_partial_customer_spend" : "platform_and_customer_spend";
}

/**
 * The weakest coverage among the rows — what the response AS A WHOLE is made of.
 *
 * Weakest wins because the marker is an admission: a payload holding one fully-costed chain and one
 * that could not be costed at all is not a fully-costed payload, and a reader taking the summary at
 * face value must never be told more than the least-covered row supports.
 */
export function summariseCoverage(rows: ChainCostCoverage[]): ChainCostCoverage {
  if (rows.some((r) => r === "platform_and_partial_customer_spend")) return "platform_and_partial_customer_spend";
  if (rows.some((r) => r === "platform_spend_only")) return "platform_spend_only";
  return rows.length === 0 ? "platform_spend_only" : "platform_and_customer_spend";
}

const EMPTY: CustomerDeclaredCost = { costCents: 0, statedCount: 0, unstatedCount: 0 };

/** One statement, reduced to the two things this partition needs. */
export interface AttributableCost {
  campaignId: string | null;
  costCents: number | null;
}

/**
 * PURE: split the brand's statements across the offer's chains by campaign, and report what is left.
 *
 * `chains` maps a chain key to its campaign set. Every statement lands in exactly one bucket, and the
 * leftovers are the ones no chain of this offer can claim.
 */
export function partitionCustomerCosts(
  costs: AttributableCost[],
  chains: Array<{ key: string; campaignIds: string[] }>,
): { byChain: Record<string, CustomerDeclaredCost>; unattributed: CustomerDeclaredCost } {
  const chainOfCampaign = new Map<string, string>();
  const byChain: Record<string, CustomerDeclaredCost> = {};
  for (const chain of chains) {
    byChain[chain.key] = { ...EMPTY };
    for (const campaignId of chain.campaignIds) chainOfCampaign.set(campaignId, chain.key);
  }
  const unattributed: CustomerDeclaredCost = { ...EMPTY };

  for (const cost of costs) {
    const key = cost.campaignId ? chainOfCampaign.get(cost.campaignId) : undefined;
    const bucket = key ? byChain[key] : unattributed;
    if (cost.costCents === null) bucket.unstatedCount += 1;
    else {
      bucket.costCents += cost.costCents;
      bucket.statedCount += 1;
    }
  }
  return { byChain, unattributed };
}
