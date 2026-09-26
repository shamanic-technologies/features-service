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
  /**
   * The MATURITY DELAY the three ratios above were measured under (`lib/roi-maturity.ts`): they divide
   * the MATURE cohort's pipeline by the MATURE cohort's committed spend — runs started before
   * `today − maturityDays` and the leads first contacted before it — while `committedCostUsd` and the
   * headline pipeline keep the whole history. 0 when nothing in scope waits for its outcomes, in which
   * case the ratios are over the whole scope, exactly as before.
   */
  maturityDays: number;
  /**
   * WHY the ratios are null when they are null for a reason other than "nothing to divide".
   * `maturing` = every dollar in scope is younger than the maturity delay, so there is no mature
   * cohort to measure yet — a young campaign, not a bad one. Never 0 in its place.
   */
  unmeasuredReason: MaturityReason | null;
}

/**
 * `maturing` — spent, but nothing spent is mature yet. `maturity_unknown` — campaign-service could not
 * say which campaigns wait for their outcomes, so the mature cohort cannot be told apart.
 */
export type MaturityReason = "maturing" | "maturity_unknown";

/** The mature cohort a CostEconomics' ratios were computed on — what every ratio divided. */
export interface MatureBasis {
  committedCents: number;
  pipelineUsd: number | null;
  days: number;
}

/**
 * The mature basis behind each block this module built, kept OFF the wire on purpose: the owner's rule
 * is that no cohort spend figure is displayed anywhere, while an in-process consumer needs it — the
 * fleet warm, which stores ingredients and divides later. A block rebuilt from JSON (a cached snapshot) carries no
 * entry, and every reader FAILS LOUD on that rather than dividing the whole history instead.
 */
const MATURE_BASIS = new WeakMap<object, MatureBasis>();

export function matureBasisOf(economics: CostEconomics): MatureBasis {
  const basis = MATURE_BASIS.get(economics);
  if (!basis) {
    throw new Error("cost economics block carries no mature basis (it was not built by buildCostEconomics in this process)");
  }
  return basis;
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
  /**
   * The MATURE cohort the ratios divide (`lib/roi-maturity.ts`). Omitted → nothing in scope waits for
   * its outcomes, and the ratios ride the whole scope (`maturityDays: 0`), byte-identical to before.
   */
  maturity?: { days: number; committedCostInUsdCents: number; totalPipelineUsd: number | null } | { unknown: true };
}): CostEconomics {
  const { committedCostInUsdCents, actualCostInUsdCents, totalPipelineUsd, lifetimeRevenueUsd, maturity } = input;
  const committedCostUsd = committedCostInUsdCents / 100;
  const actualCostUsd = actualCostInUsdCents / 100;
  if (maturity && "unknown" in maturity) {
    const block: CostEconomics = {
      committedCostUsd,
      actualCostUsd,
      costOfAcquisitionPct: null,
      roiMultiple: null,
      costPerAcquisitionUsd: null,
      maturityDays: 0,
      unmeasuredReason: "maturity_unknown",
    };
    MATURE_BASIS.set(block, { committedCents: 0, pipelineUsd: null, days: 0 });
    return block;
  }
  const days = maturity && maturity.days > 0 ? maturity.days : 0;
  const basisCents = maturity && days > 0 ? maturity.committedCostInUsdCents : committedCostInUsdCents;
  const basisPipeline = maturity && days > 0 ? maturity.totalPipelineUsd : totalPipelineUsd;
  // Spent something, and none of it is old enough yet: there is no cohort to measure, and saying so
  // is a different statement from "nothing was spent" (which leaves the reason null).
  const maturing = days > 0 && basisCents <= 0 && committedCostInUsdCents > 0;
  const ratios = maturing
    ? { costOfAcquisitionPct: null, roiMultiple: null, costPerAcquisitionUsd: null }
    : ratiosOf(basisCents / 100, basisPipeline, lifetimeRevenueUsd);
  const block: CostEconomics = {
    committedCostUsd,
    actualCostUsd,
    ...ratios,
    maturityDays: days,
    unmeasuredReason: maturing ? "maturing" : null,
  };
  MATURE_BASIS.set(block, { committedCents: basisCents, pipelineUsd: basisPipeline, days });
  return block;
}

function ratiosOf(
  committedCostUsd: number,
  totalPipelineUsd: number | null,
  lifetimeRevenueUsd: number | null | undefined,
): Pick<CostEconomics, "costOfAcquisitionPct" | "roiMultiple" | "costPerAcquisitionUsd"> {
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
  return { costOfAcquisitionPct, roiMultiple, costPerAcquisitionUsd };
}
