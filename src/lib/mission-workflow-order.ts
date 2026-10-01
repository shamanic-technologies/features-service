/**
 * THE ORDER OF A MISSION'S WORKFLOWS — learning workflows already cheaper than the best mature one, then
 * the CHEAPEST MATURE workflow for the offer (owner rules 2026-09-30, 2026-10-01).
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
 *   2. LEARNING workflows (no mature price anywhere) whose LEARNING price is already CHEAPER than the
 *      best mature workflow's mature price (the head of tiers 3-5), cheapest first — the same rule as the
 *      general order and the fleet leg ranking (owner 2026-10-01: they go above it, the money goes there);
 *   3. mature on the OFFER (cost > 0), ascending;
 *   4. mature on the BRAND, ascending;
 *   5. mature on the FLEET, ascending;
 *   6. the other workflows with no mature price, in the general order (`fallbackPosition`:
 *      measured-cheapest first, never-run last);
 *   7. retired lineages.
 * The LEARNING price is the general order's own figure (`learningCostPerOutcomeUsd`: the dynasty's best
 * rankable resolved cost per outcome, flash with its cascade floor), never a new one. The dynasty slug
 * breaks a tie only once every price above is exhausted, so the order is total.
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
  /**
   * The general order's figure for this workflow (its best rankable resolved cost per outcome), null when
   * it has none. Read only for a workflow with no mature price: it decides whether it beats the best mature.
   */
  learningCostPerOutcomeUsd?: number | null;
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
    const tier = e.retired ? MISSION_PRICE_GRAINS.length + 2 : price ? MISSION_PRICE_GRAINS.indexOf(price.grain) + 1 : MISSION_PRICE_GRAINS.length + 1;
    const learning = !e.retired && !price && e.learningCostPerOutcomeUsd != null && e.learningCostPerOutcomeUsd > 0 ? e.learningCostPerOutcomeUsd : null;
    return { e, excluded: e.excluded ? 1 : 0, tier, cost: price?.costPerOutcomeUsd ?? null, learning };
  });
  const byOrder = (a: (typeof keyed)[number], b: (typeof keyed)[number]): number => {
    if (a.excluded !== b.excluded) return a.excluded - b.excluded;
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.cost != null && b.cost != null && a.cost !== b.cost) return a.cost - b.cost;
    if (a.tier === 0 && a.learning !== b.learning) return a.learning! - b.learning!;
    if (a.cost == null && a.e.fallbackPosition !== b.e.fallbackPosition) return a.e.fallbackPosition - b.e.fallbackPosition;
    return a.e.slug < b.e.slug ? -1 : a.e.slug > b.e.slug ? 1 : 0;
  };
  // Within each assignment group, a learning workflow cheaper than the group's best mature one moves above it.
  for (const excluded of [0, 1]) {
    const group = keyed.filter((k) => k.excluded === excluded);
    const bestMature = group.filter((k) => k.cost != null).sort(byOrder)[0];
    if (!bestMature) continue;
    for (const k of group) if (k.learning != null && k.learning < bestMature.cost!) k.tier = 0;
  }
  return keyed.sort(byOrder).map((x) => x.e.slug);
}
