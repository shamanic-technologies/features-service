/**
 * THE RETURN A CUSTOMER IS SHOWN for a scope, picked from the `costEconomics.maturity` pair this service
 * already serves (`lib/cost-economics.ts`). It computes NO return: it only chooses which served half a
 * customer reads, so every surface stating "your return" (the dashboard, the subscription email through
 * the org period recap) states the same number.
 *
 * The rule is the dashboard's for every customer (distribute.you `apps/dashboard/src/lib/maturity.ts`:
 * `autoStatBasis` picks the half, `shownReturn` states it), so it is the owner's two rules composed:
 *   - 2026-10-08 ("flash si ROI plus haut, fais-le"): the HIGHER half is stated. Flash when its return is
 *     above the mature one; mature when mature is higher or equal. A mature half still Learning
 *     (`isMature: false`) has no return to compare, so flash wins there only above break-even (> 1);
 *   - 2026-10-03: a scope not mature whose to-date return is at or under 1x states nothing (the dashboard
 *     reads `Learning`): a thin figure under 1x would read as a verdict.
 * Prod 2026-10-19 (SHOWCASE-RETURN-SAME-BASIS-1019): Doc Dinners, flash 2.21x / mature 0.74x, read 2.2x on
 * its Today page and 0.75x on the homepage card, which stated the mature half alone.
 * Change one, change both.
 */
import type { MaturityPair } from "./maturity.js";

export type ServedReturnHalf = "mature" | "flash";

/**
 * - `return_learning`: the scope is not mature and its to-date return is not above 1x (dashboard: Learning).
 * - `return_unavailable`: no pair was served, or the half the rule picks holds no figure (dashboard: —).
 */
export type ServedReturnNullReason = "return_learning" | "return_unavailable";

export interface ServedReturn {
  roiMultiple: number | null;
  half: ServedReturnHalf | null;
  nullReason: ServedReturnNullReason | null;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** PURE. The return a customer is shown for one served pair (rule in the header). */
export function servedReturnOf(pair: MaturityPair<{ roiMultiple: number | null }> | null | undefined): ServedReturn {
  if (!pair) return { roiMultiple: null, half: null, nullReason: "return_unavailable" };
  const flash = finite(pair.flash?.roiMultiple) ? (pair.flash?.roiMultiple as number) : null;
  // `autoStatBasis`: a mature half the producer calls Learning has no return to compare.
  const mature = pair.isMature !== false && finite(pair.mature?.roiMultiple) ? (pair.mature?.roiMultiple as number) : null;
  if (flash !== null && (mature === null ? flash > 1 : flash > mature)) {
    return { roiMultiple: flash, half: "flash", nullReason: null };
  }
  if (mature !== null) return { roiMultiple: mature, half: "mature", nullReason: null };
  return { roiMultiple: null, half: null, nullReason: pair.isMature === false ? "return_learning" : "return_unavailable" };
}
