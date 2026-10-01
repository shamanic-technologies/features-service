/**
 * THE ORDER OF A MISSION'S WORKFLOWS — the money goes to the CHEAPEST MATURE workflow for the offer
 * (owner rules 2026-09-30, 2026-10-01).
 *
 * A mission is a leg-keyed `workflow-projection` read naming a `?campaignId=` whose campaign states an
 * offer. Its `rank` is decided by MATURE cost per outcome, finest grain first: the offer's own price; a
 * workflow not mature on the offer yet is placed on its BRAND mature price, then on its FLEET (crossOrg)
 * mature price. So while a young offer has no mature evidence, the order is the cheapest mature workflow
 * on the next coarser grain that has one — never the alphabet (prod 2026-10-01: a 2-day-old mission
 * tied every workflow and ranked estuary first while the money went to osprey, $2.26 per visit on the
 * fleet).
 *
 * Tiers, outermost first:
 *   1. selectable on the leg before non-selectable (leg assignment);
 *   2. mature on the OFFER (cost > 0), ascending;
 *   3. mature on the BRAND, ascending;
 *   4. mature on the FLEET, ascending;
 *   5. no mature price anywhere, in the general order (`fallbackPosition`: measured-cheapest first,
 *      never-run last);
 *   6. retired lineages.
 * The dynasty slug breaks a tie only once every price above is exhausted, so the order is total.
 */
export interface GrainMaturityFigures {
  isMature?: boolean | null;
  mature?: { costPerOutcomeUsd: number | null } | null;
}

/** The price-carrying grains of a workflow's brand-level row, finest first. */
export const MISSION_PRICE_GRAINS = ["offer", "brand", "crossOrg"] as const;
export type MissionPriceGrain = (typeof MISSION_PRICE_GRAINS)[number];

export interface MissionWorkflowEntry {
  slug: string;
  /** Not assigned active on the leg — sorts after every selectable workflow. */
  excluded: boolean;
  retired?: boolean;
  /** The grain blocks of the workflow's brand-level row; a grain is absent when it has no evidence. */
  grains: Partial<Record<MissionPriceGrain, GrainMaturityFigures | null>>;
  /** Position in the general (non-mission) order — orders the workflows no mature price places. */
  fallbackPosition: number;
}

/** A grain's MATURE price, or null (learning, no outcome, no evidence). */
export function maturePrice(block: GrainMaturityFigures | null | undefined): number | null {
  if (!block || block.isMature !== true) return null;
  const cost = block.mature?.costPerOutcomeUsd ?? null;
  return cost != null && cost > 0 ? cost : null;
}

/** The finest grain on which a workflow holds a mature price, with that price; null when none. */
export function missionPriceOf(e: Pick<MissionWorkflowEntry, "grains">): { grain: MissionPriceGrain; costPerOutcomeUsd: number } | null {
  for (const grain of MISSION_PRICE_GRAINS) {
    const cost = maturePrice(e.grains[grain]);
    if (cost != null) return { grain, costPerOutcomeUsd: cost };
  }
  return null;
}

/** The dynasty slugs in mission order. */
export function orderMissionWorkflows(entries: MissionWorkflowEntry[]): string[] {
  const keyed = entries.map((e) => {
    const price = e.retired ? null : missionPriceOf(e);
    const tier = e.retired ? MISSION_PRICE_GRAINS.length + 1 : price ? MISSION_PRICE_GRAINS.indexOf(price.grain) : MISSION_PRICE_GRAINS.length;
    return { e, excluded: e.excluded ? 1 : 0, tier, cost: price?.costPerOutcomeUsd ?? null };
  });
  return keyed
    .sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded - b.excluded;
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.cost != null && b.cost != null && a.cost !== b.cost) return a.cost - b.cost;
      if (a.cost == null && a.e.fallbackPosition !== b.e.fallbackPosition) return a.e.fallbackPosition - b.e.fallbackPosition;
      return a.e.slug < b.e.slug ? -1 : a.e.slug > b.e.slug ? 1 : 0;
    })
    .map((x) => x.e.slug);
}
