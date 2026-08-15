/**
 * Derived cost economics for whatever scope a revenue body describes — a brand, one campaign
 * identity, or one workflow. ALWAYS present.
 *
 * ROI / CAC are computed on REALIZED spend — `actualCostUsd` carries ACTUAL (billed) cost ONLY, NOT
 * the committed total (which includes provisioned holds). Naming follows the service-wide
 * total/actual/provisioned convention: a forward-looking "money reserved" figure (the `spend` block's
 * total…) must never inflate ROI/CAC, so the field is named `actualCostUsd` to make the realized basis
 * unambiguous and distinct from the committed `total…` figures. (Same source as /stats
 * systemStats.actualCostInUsdCents and the `spend` block's actualSpentCents.)
 *   - actualCostUsd:         ACTUAL (billed) run cost in dollars (excludes provisioned holds), >= 0.
 *   - costOfAcquisitionPct:  (actualCostUsd / totalPipelineUsd) * 100; null when pipeline is null OR 0.
 *   - roiMultiple:           totalPipelineUsd / actualCostUsd; null when cost is 0 OR pipeline is null.
 *   - costPerAcquisitionUsd: what it cost to win ONE customer, for whatever scope this body describes.
 *                            Present on EVERY body, the un-lensed brand read included — see below.
 *   - expectedConversions:   LENS ONLY — sum of per-lead conversion probability (decimal) across the
 *                            lensed leads (totalPipelineUsd = expectedConversions × LTR). Absent off-lens.
 *   - costPerConversionUsd:  LENS ONLY — actualCostUsd / expectedConversions; null when expectedConversions
 *                            is 0. Absent off-lens.
 *
 * COST PER ACQUISITION IS NOT A NEW COMPUTATION — it was already implied by two fields sitting side by
 * side. A brand's pipeline is `expected paying clients × lifetime revenue`, so the expected client
 * COUNT is `totalPipelineUsd / lifetimeRevenueUsd` and the dollar cost of one of them is
 * `actualCostUsd ÷ that count` = `(costOfAcquisitionPct / 100) × lifetimeRevenueUsd` = `LTR ÷
 * roiMultiple`. The three are one statement in three units, which is exactly why the Overview can show
 * Pipeline / ROI / %CAC and then render a dash for $CAC and look broken rather than scoped.
 *
 * It was previously reachable only on a `?lens=` read (as `costPerConversionUsd`), and the brand
 * Overview is not lensed — it is the whole brand, every funnel. The identity above is why the un-lensed
 * figure MATCHES the lensed one for the same scope instead of being a second opinion: the lens divides
 * the same realized spend by `Σ per-lead probability`, and that sum IS `lensPipeline / LTR`. Same
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
  actualCostUsd: number;
  costOfAcquisitionPct: number | null;
  roiMultiple: number | null;
  /** REALIZED — actual spend ÷ expected paying clients. null when unmeasurable; never 0 as a stand-in. */
  costPerAcquisitionUsd: number | null;
  expectedConversions?: number;
  costPerConversionUsd?: number | null;
}

export function buildCostEconomics(
  actualCostInUsdCents: number,
  totalPipelineUsd: number | null,
  // The brand's lifetime revenue per paying client, from the SAME resolved (declared-funnel-priced)
  // economics that produced `totalPipelineUsd`. Omitted on the paths that have no economics at all
  // (no funnel wired / cold start) → costPerAcquisitionUsd is null, which is the honest answer there.
  lifetimeRevenueUsd?: number | null,
): CostEconomics {
  const actualCostUsd = actualCostInUsdCents / 100;
  const costOfAcquisitionPct =
    totalPipelineUsd === null || totalPipelineUsd === 0 ? null : (actualCostUsd / totalPipelineUsd) * 100;
  const roiMultiple =
    actualCostUsd === 0 || totalPipelineUsd === null ? null : totalPipelineUsd / actualCostUsd;
  // expected paying clients = pipeline / LTR; a 0 or absent LTR leaves the count undefined, not zero.
  const expectedPaidClients =
    totalPipelineUsd === null || lifetimeRevenueUsd == null || !(lifetimeRevenueUsd > 0)
      ? null
      : totalPipelineUsd / lifetimeRevenueUsd;
  const costPerAcquisitionUsd =
    expectedPaidClients === null || expectedPaidClients === 0 ? null : actualCostUsd / expectedPaidClients;
  return { actualCostUsd, costOfAcquisitionPct, roiMultiple, costPerAcquisitionUsd };
}
