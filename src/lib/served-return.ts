/**
 * THE RETURN A CUSTOMER IS SHOWN for a scope, picked from the `costEconomics.maturity` pair this service
 * already serves (`lib/cost-economics.ts`). It computes NO return: it only chooses which served half a
 * customer reads, so every surface stating "your return" (the dashboard, the subscription email through
 * the org period recap) states the same number.
 *
 * The rule is the owner's (2026-10-03), applied by the dashboard's `shownReturn` (distribute.you
 * `apps/dashboard/src/lib/maturity.ts`) on the customer's `mature` basis:
 *   - the scope is mature (or the producer cannot judge, `isMature: null`) → the MATURE half;
 *   - the scope is NOT mature → the to-date (FLASH) half when it is above break-even (> 1), else nothing
 *     (the dashboard reads `Learning`): a thin figure under 1x would read as a verdict, and the flash half
 *     is the conservative one (spend whose outcomes have not landed pulls it down, never up).
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
  if (pair.isMature === false) {
    const toDate = pair.flash?.roiMultiple;
    return finite(toDate) && toDate > 1
      ? { roiMultiple: toDate, half: "flash", nullReason: null }
      : { roiMultiple: null, half: null, nullReason: "return_learning" };
  }
  const mature = pair.mature?.roiMultiple;
  return finite(mature)
    ? { roiMultiple: mature, half: "mature", nullReason: null }
    : { roiMultiple: null, half: null, nullReason: "return_unavailable" };
}
