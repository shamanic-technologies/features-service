/**
 * A MISSION'S MATURE PRICE — read finest grain first (owner rules 2026-09-30, 2026-10-01): the offer's own
 * mature cost per outcome; a workflow not mature on the offer yet is placed on its BRAND mature price, then on
 * its FLEET (crossOrg) mature price. So a young offer is ordered on the next coarser grain that has a mature
 * price, never the alphabet (prod 2026-10-01: a 2-day-old mission ranked estuary first while the money went to
 * osprey, $2.26 per visit on the fleet). The ORDER that uses it is the shared leg order
 * (`lib/leg-workflow-order.ts`, WF-ORDER-EXPLORE-1018).
 */
export interface GrainMaturityFigures {
  isMature?: boolean | null;
  mature?: { costPerOutcomeUsd: number | null } | null;
}

/** The price-carrying grains of a workflow's brand-level row, finest first. */
export const MISSION_PRICE_GRAINS = ["offer", "brand", "crossOrg"] as const;
export type MissionPriceGrain = (typeof MISSION_PRICE_GRAINS)[number];


/** A grain's MATURE price, or null (learning, no outcome, no evidence). */
export function maturePrice(block: GrainMaturityFigures | null | undefined): number | null {
  if (!block || block.isMature !== true) return null;
  const cost = block.mature?.costPerOutcomeUsd ?? null;
  return cost != null && cost > 0 ? cost : null;
}

/** The finest grain on which a workflow holds a mature price, with that price; null when none. */
export function missionPriceOf(e: { grains: Partial<Record<MissionPriceGrain, GrainMaturityFigures | null>> }): { grain: MissionPriceGrain; costPerOutcomeUsd: number } | null {
  for (const grain of MISSION_PRICE_GRAINS) {
    const cost = maturePrice(e.grains[grain]);
    if (cost != null) return { grain, costPerOutcomeUsd: cost };
  }
  return null;
}
