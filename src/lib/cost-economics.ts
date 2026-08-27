/**
 * Derived cost economics for whatever scope a revenue body describes — a brand, one campaign
 * identity, or one workflow. ALWAYS present.
 *
 * THERE IS EXACTLY ONE SPEND BASIS IN THIS SERVICE, AND IT IS COMMITTED (billed `actual` + the open
 * `provisioned` holds — runs-service's `totalCostInUsdCents`). ROI, %CAC, cost per acquisition and
 * the lensed cost per conversion all divide by `committedCostUsd`, which is byte the same total the
 * `/revenue` `spend` block reports and the same total its cost-per-outcome columns already divided
 * by. A second basis is a BUG, not a tradeoff: while ROI rode billed-only and the spend block rode
 * committed, one payload answered "how much did this cost" two ways at once, and a brand running a
 * single campaign read $202 on its Overview beside $191 on its campaigns table — same brand, same
 * feature, same day. Do NOT reintroduce a split, do NOT add a parameter to pick a basis, and do NOT
 * ask a consumer to reconcile two spend fields.
 *
 *   - committedCostUsd:      COMMITTED run cost in dollars (billed + open holds), >= 0. THE basis.
 *   - actualCostUsd:         billed-only run cost in dollars, >= 0. TRANSITIONAL AND REPORTED ONLY —
 *                            it is kept populated (and honest, i.e. still billed-only) so a consumer
 *                            rendering "$ Invested" off the old field has a gap-free path onto
 *                            `committedCostUsd`. NOTHING divides by it. A field whose name asserts
 *                            "actual" must never start carrying a committed value.
 *   - costOfAcquisitionPct:  (committedCostUsd / totalPipelineUsd) * 100; null when pipeline is null OR 0.
 *   - roiMultiple:           totalPipelineUsd / committedCostUsd; null when cost is 0 OR pipeline is null.
 *   - costPerAcquisitionUsd: what it cost to win ONE customer, for whatever scope this body describes.
 *                            Present on EVERY body, the un-lensed brand read included — see below.
 *   - expectedConversions:   LENS ONLY — sum of per-lead conversion probability (decimal) across the
 *                            lensed leads (totalPipelineUsd = expectedConversions × LTR). Absent off-lens.
 *   - costPerConversionUsd:  LENS ONLY — committedCostUsd / expectedConversions; null when
 *                            expectedConversions is 0. Absent off-lens.
 *
 * COST PER ACQUISITION IS NOT A NEW COMPUTATION — it was already implied by two fields sitting side by
 * side. A brand's pipeline is `expected paying clients × lifetime revenue`, so the expected client
 * COUNT is `totalPipelineUsd / lifetimeRevenueUsd` and the dollar cost of one of them is
 * `committedCostUsd ÷ that count` = `(costOfAcquisitionPct / 100) × lifetimeRevenueUsd` = `LTR ÷
 * roiMultiple`. The three are one statement in three units, which is exactly why the Overview can show
 * Pipeline / ROI / %CAC and then render a dash for $CAC and look broken rather than scoped.
 *
 * It was previously reachable only on a `?lens=` read (as `costPerConversionUsd`), and the brand
 * Overview is not lensed — it is the whole brand, every funnel. The identity above is why the un-lensed
 * figure MATCHES the lensed one for the same scope instead of being a second opinion: the lens divides
 * the same committed spend by `Σ per-lead probability`, and that sum IS `lensPipeline / LTR`. Same
 * economics in, same dollars out, and `revenue.test.ts` drives both from one fixture to keep it so.
 *
 * NULL, never 0, when the brand states no lifetime revenue, when it is 0, or when the pipeline is
 * null/0 — "we could not measure this" and "a customer costs nothing" are different statements.
 *
 * Lives in its own module (rather than beside the route that first needed it) so every grain can build
 * it from the SAME function without importing a route: the brand Overview and the per-campaign groups
 * (`routes/revenue.ts`), the cross-org public revenue (`routes/public.ts`) and the per-workflow groups
 * (`lib/workflow-revenue.ts`). `routes/revenue.ts` re-exports both names, so nothing that already
 * imported them from there had to change.
 */
export interface CostEconomics {
  /** COMMITTED (billed + open holds) spend for this scope, in dollars. The single basis. */
  committedCostUsd: number;
  /** Billed-only spend, in dollars. TRANSITIONAL — reported for consumer migration, divided by nowhere. */
  actualCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
  /** Committed spend ÷ expected paying clients. null when unmeasurable; never 0 as a stand-in. */
  costPerAcquisitionUsd: number | null;
  expectedConversions?: number;
  costPerConversionUsd?: number | null;
}

/**
 * Takes an object rather than positional cents so the two bases can never be swapped at a call site —
 * a transposed `(actual, committed)` pair would compile fine and silently reinstate the split basis
 * this exists to remove.
 */
export function buildCostEconomics(input: {
  /** runs-service `totalCostInUsdCents` for the scope (gross or frozen-net per `?pricing=`). */
  committedCostInUsdCents: number;
  /** runs-service `actualCostInUsdCents` for the same scope. Reported only. */
  actualCostInUsdCents: number;
  totalPipelineUsd: number | null;
  // The brand's lifetime revenue per paying client, from the SAME resolved (declared-funnel-priced)
  // economics that produced `totalPipelineUsd`. Omitted on the paths that have no economics at all
  // (no funnel wired / cold start) → costPerAcquisitionUsd is null, which is the honest answer there.
  lifetimeRevenueUsd?: number | null;
}): CostEconomics {
  const { committedCostInUsdCents, actualCostInUsdCents, totalPipelineUsd, lifetimeRevenueUsd } = input;
  const committedCostUsd = committedCostInUsdCents / 100;
  const actualCostUsd = actualCostInUsdCents / 100;
  const costOfAcquisitionPct =
    totalPipelineUsd === null || totalPipelineUsd === 0 ? null : (committedCostUsd / totalPipelineUsd) * 100;
  const roiMultiple =
    committedCostUsd === 0 || totalPipelineUsd === null ? null : totalPipelineUsd / committedCostUsd;
  // expected paying clients = pipeline / LTR; a 0 or absent LTR leaves the count undefined, not zero.
  const expectedPaidClients =
    totalPipelineUsd === null || lifetimeRevenueUsd == null || !(lifetimeRevenueUsd > 0)
      ? null
      : totalPipelineUsd / lifetimeRevenueUsd;
  const costPerAcquisitionUsd =
    expectedPaidClients === null || expectedPaidClients === 0 ? null : committedCostUsd / expectedPaidClients;
  return { committedCostUsd, actualCostUsd, costOfAcquisitionPct, roiMultiple, costPerAcquisitionUsd };
}

/**
 * THE SAME SCOPE'S MONEY WITH THE CUSTOMER'S OWN LEGS IN IT — reported BESIDE the charged figures,
 * never inside them.
 *
 * The platform automates the first link of a sales chain and bills for it; the customer performs the
 * rest, and lead-service records what those legs cost them. A cost of acquisition that counts only the
 * billed link is too small for every chain that ends in a human leg, and the return that divides by it
 * is too good — the single most misleading figure a customer can be shown about their own money.
 *
 * The two kinds of money stay TELLABLE APART, which is why this is a second block rather than a wider
 * `committedCostUsd`. What we CHARGED them is a billing fact this service reports elsewhere and must
 * keep reporting unchanged; what THEY spent is their own statement, owned by them, in no ledger of
 * ours. Both spends are stated on this block, so a consumer renders either without inferring one from
 * the other, and nothing here ever reaches billing.
 *
 * The ratios are the byte-same three `buildCostEconomics` computes, off the summed basis and the SAME
 * lifetime revenue — so with nothing declared this block is identical to the charged one, and the day
 * a customer states a cost the whole ladder moves together instead of one figure drifting from the
 * others.
 */
export interface CombinedCostEconomics {
  /** What the platform CHARGED for this scope, in dollars — byte-equal to `costEconomics.committedCostUsd`. */
  platformCommittedCostUsd: number;
  /** What the CUSTOMER states their own legs cost them, in dollars. Never charged, never billed. */
  customerDeclaredCostUsd: number;
  /** The two together — the basis the three figures below divide by. */
  committedCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
  costPerAcquisitionUsd: number | null;
}

export function buildCombinedCostEconomics(input: {
  /** The charged block for the same scope — its committed total is one half of the basis. */
  charged: CostEconomics;
  /** The customer's stated cost for the same scope, in cents. 0 when nobody stated one. */
  customerDeclaredCostCents: number;
  totalPipelineUsd: number | null;
  lifetimeRevenueUsd?: number | null;
}): CombinedCostEconomics {
  const { charged, customerDeclaredCostCents, totalPipelineUsd, lifetimeRevenueUsd } = input;
  const customerDeclaredCostUsd = customerDeclaredCostCents / 100;
  const combined = buildCostEconomics({
    // Cents in, cents out — the charged half is carried back at full precision rather than
    // re-rounded, since runs-service returns fractional cents per group.
    committedCostInUsdCents: charged.committedCostUsd * 100 + customerDeclaredCostCents,
    // Reported only, and not by this block: an "actual" figure asserts BILLED money, and the customer's
    // own spend was never billed. It is dropped here rather than quietly widened.
    actualCostInUsdCents: 0,
    totalPipelineUsd,
    lifetimeRevenueUsd,
  });
  return {
    platformCommittedCostUsd: charged.committedCostUsd,
    customerDeclaredCostUsd,
    committedCostUsd: combined.committedCostUsd,
    costOfAcquisitionPct: combined.costOfAcquisitionPct,
    roiMultiple: combined.roiMultiple,
    costPerAcquisitionUsd: combined.costPerAcquisitionUsd,
  };
}
