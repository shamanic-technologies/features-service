/**
 * EVERY OFFER HAS A LIFETIME REVENUE (owner 2026-10-09, verbatim: "We always need a LTR, it can nerver be
 * 0. Fill it by default with our median value").
 *
 * Precedence, the same spirit as the leg rates (stated > fleet median): the offer's STATED lifetime revenue,
 * else the FLEET MEDIAN of every offer's stated lifetime revenue (one data point per offer, computed in the
 * fleet stated-median sweep of `lib/effective-conversion-rates.ts`, warmed at boot, 15 min fresh). Never an
 * average, never per brand, never 0. The source rides with the value (`offer_stated` | `fleet_median`) so a
 * consumer can say "you stated" vs "fleet median".
 *
 * SUPERSEDES the 2026-10-05 "never a default lifetime revenue" rule: an unstated offer no longer nulls the
 * pipeline with `lifetime_revenue_not_stated`. That reason survives only for the case the default cannot
 * cover — no offer in the whole fleet states one, or the fleet sweep could not be read (logged loud).
 */

import { getFleetLifetimeRevenueMedian } from "./effective-conversion-rates.js";

/** Where an offer's lifetime revenue came from. */
export type OfferLifetimeRevenueSource = "offer_stated" | "fleet_median";

export interface ResolvedLifetimeRevenue {
  /** Null only when nothing anywhere states one (or the fleet could not be read) — never 0. */
  usd: number | null;
  source: OfferLifetimeRevenueSource | null;
}

const isStated = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** PURE: stated > fleet median > null. */
export function resolveLifetimeRevenue(
  stated: number | null | undefined,
  fleetMedianUsd: number | null | undefined,
): ResolvedLifetimeRevenue {
  if (isStated(stated)) return { usd: stated, source: "offer_stated" };
  if (isStated(fleetMedianUsd)) return { usd: fleetMedianUsd, source: "fleet_median" };
  return { usd: null, source: null };
}

/**
 * The lifetime revenue an offer is priced on. A stated value never reads the fleet. An unreadable fleet
 * sweep is logged loud and leaves the offer unpriced (`lifetime_revenue_not_stated` downstream), never a
 * guessed figure and never a 502 of the page.
 */
export async function offerLifetimeRevenue(stated: number | null | undefined): Promise<ResolvedLifetimeRevenue> {
  if (isStated(stated)) return { usd: stated, source: "offer_stated" };
  try {
    return resolveLifetimeRevenue(null, (await getFleetLifetimeRevenueMedian()).usd);
  } catch (error) {
    console.error(`[features-service] fleet lifetime-revenue median unreadable; the unstated offer stays unpriced: ${(error as Error).message}`);
    return { usd: null, source: null };
  }
}
