/**
 * THE FLEET RETURN MEDIANS, TAKEN OVER MATURE SCOPES ONLY, ON BOTH VERSIONS (`lib/maturity.ts`,
 * features-service#1196).
 *
 * The public return medians (`/public/stats/return-on-spend`, `funnel-return-on-spend`,
 * `outcome-return-on-spend`) take each brand's REALIZED return on its mature cohort. Owner decision: a
 * fleet median is taken over MATURE scopes only — a brand still inside its first three weeks, or whose
 * mature cohort has not produced its leg's count of outcomes yet, has a ratio that says how young it is
 * rather than how it performs. So beside every legacy median (all brands past the spend floor,
 * byte-unchanged) rides a `maturity` block: the SAME brands' returns restricted to the ones whose scope
 * `isMature` (the verdict `lib/scope-maturity.ts` states on the brand's own dashboard), on BOTH versions —
 * `flash` (everything to date) and `mature` (the figure each client's dashboard displays).
 *
 * Unmeasurable is its own answer, never a wider population: `maturity_not_recorded_yet` (the snapshot was
 * written before brands carried a verdict — the next warm fills it), `not_enough_brands` (too few mature
 * brands past the floor), `no_snapshot_yet`.
 */

/** One version's distribution of return per dollar across the qualifying brands. */
export interface ReturnQuantiles {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
}

export type MatureScopesReturnReason = "no_snapshot_yet" | "maturity_not_recorded_yet" | "not_enough_brands";

export interface MatureScopesReturn {
  /** Always `mature_scopes`: only brands whose own scope is mature are in the population. */
  basis: "mature_scopes";
  measured: boolean;
  reason: MatureScopesReturnReason | null;
  /** How many mature brands past the spend floor the medians were taken over — always present. */
  brandCount: number;
  /** Their return on everything to date: whole pipeline ÷ whole committed spend. */
  flash: ReturnQuantiles | null;
  /** Their return on the mature cohort — the figure each client's own dashboard displays. */
  mature: ReturnQuantiles | null;
}

/** What a stored row must carry to take part (the legacy fields are the MATURE ingredients). */
export interface MaturityReturnRow {
  /** MATURE committed spend (USD) — the legacy row's `committedSpendUsd`. The spend floor applies to it. */
  committedSpendUsd: number;
  /** MATURE pipeline (USD), null when unpriced — the legacy row's `expectedPipelineUsd`. */
  expectedPipelineUsd: number | null;
  /** Whole-history committed spend. Absent on a row written before it existed. */
  flashCommittedSpendUsd?: number;
  /** Whole-history pipeline, null when unpriced. Absent on a row written before it existed. */
  flashExpectedPipelineUsd?: number | null;
  /** The scope's verdict. ABSENT = not recorded (an older row); null = the cut could not be made. */
  isMature?: boolean | null;
}

/** Linear-interpolated quantile of a NON-EMPTY ascending array (the rule every fleet median here uses). */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function quantilesOf(values: readonly number[]): ReturnQuantiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * PURE. The medians over the MATURE brands of `rows` past `minSpendUsd` of mature spend. `isMatureOf`
 * reads a row's verdict for the question asked (the brand's scope by default; a leg-keyed read passes the
 * brand's verdict on that leg). A brand qualifies when it is mature AND both its returns are priced.
 */
export function buildMatureScopesReturn<R extends MaturityReturnRow>(
  rows: readonly R[] | null,
  minSpendUsd: number,
  minBrands: number,
  isMatureOf: (row: R) => boolean | null | undefined = (row) => row.isMature,
): MatureScopesReturn {
  const empty = (reason: MatureScopesReturnReason, brandCount: number): MatureScopesReturn => ({
    basis: "mature_scopes",
    measured: false,
    reason,
    brandCount,
    flash: null,
    mature: null,
  });
  if (rows === null) return empty("no_snapshot_yet", 0);
  if (rows.length > 0 && rows.every((r) => isMatureOf(r) === undefined)) return empty("maturity_not_recorded_yet", 0);

  const flash: number[] = [];
  const mature: number[] = [];
  for (const row of rows) {
    if (isMatureOf(row) !== true) continue;
    if (!(row.committedSpendUsd >= minSpendUsd) || row.committedSpendUsd <= 0) continue;
    if (row.expectedPipelineUsd === null) continue;
    const flashSpend = row.flashCommittedSpendUsd;
    const flashPipeline = row.flashExpectedPipelineUsd;
    if (flashSpend === undefined || flashSpend <= 0 || flashPipeline === undefined || flashPipeline === null) continue;
    mature.push(row.expectedPipelineUsd / row.committedSpendUsd);
    flash.push(flashPipeline / flashSpend);
  }
  if (mature.length < minBrands) return empty("not_enough_brands", mature.length);
  return {
    basis: "mature_scopes",
    measured: true,
    reason: null,
    brandCount: mature.length,
    flash: quantilesOf(flash),
    mature: quantilesOf(mature),
  };
}

/**
 * PURE. Several verdicts about one brand (the orgs claiming it, or the legs of one outcome it performs)
 * as one: any `false` → false (a young part is a young whole); else any unknown → null; else true.
 * `undefined` = nothing recorded; it stays undefined only when every input is.
 */
export function combineVerdicts(verdicts: ReadonlyArray<boolean | null | undefined>): boolean | null | undefined {
  if (verdicts.length === 0 || verdicts.every((v) => v === undefined)) return undefined;
  if (verdicts.some((v) => v === false)) return false;
  if (verdicts.some((v) => v === null || v === undefined)) return null;
  return true;
}
