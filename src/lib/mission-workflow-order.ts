/**
 * THE ORDER OF A MISSION'S WORKFLOWS — the offer's own cost per outcome, ascending (owner rule 2026-09-30).
 *
 * A mission is a leg-keyed `workflow-projection` read naming a `?campaignId=` whose campaign states an
 * offer. Its `rank` is decided by ONE figure: the offer grain's MATURE cost per outcome — the number the
 * dashboard prints in the Offer column. Never the cheapest audience cell, never the fleet, never spend.
 *
 * Tiers, outermost first:
 *   1. selectable on the leg before non-selectable (leg assignment);
 *   2. PRICED (offer grain mature, cost > 0), ascending cost;
 *   3. offer evidence but no price (still learning on the offer, or no outcome there);
 *   4. no offer evidence (never ran for this offer);
 *   5. retired lineages.
 * The dynasty slug breaks every tie, so the order is total and deterministic.
 */
export interface OfferGrainFigures {
  isMature?: boolean | null;
  mature?: { costPerOutcomeUsd: number | null } | null;
}

export interface MissionWorkflowEntry {
  slug: string;
  /** Not assigned active on the leg — sorts after every selectable workflow. */
  excluded: boolean;
  retired?: boolean;
  /** The offer grain block of the workflow's brand-level row; absent when it has no offer evidence. */
  offer?: OfferGrainFigures | null;
}

/** The price a mission orders a workflow on, or null (learning, no outcome, no evidence). */
export function offerPrice(offer: OfferGrainFigures | null | undefined): number | null {
  if (!offer || offer.isMature !== true) return null;
  const cost = offer.mature?.costPerOutcomeUsd ?? null;
  return cost != null && cost > 0 ? cost : null;
}

function tierOf(e: MissionWorkflowEntry): number {
  if (e.retired) return 3;
  if (!e.offer) return 2;
  return offerPrice(e.offer) != null ? 0 : 1;
}

/** The dynasty slugs in mission order. */
export function orderMissionWorkflows(entries: MissionWorkflowEntry[]): string[] {
  return entries
    .map((e) => ({ e, excluded: e.excluded ? 1 : 0, tier: tierOf(e), price: offerPrice(e.offer) }))
    .sort((a, b) => {
      if (a.excluded !== b.excluded) return a.excluded - b.excluded;
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 0 && a.price !== b.price) return a.price! - b.price!;
      return a.e.slug < b.e.slug ? -1 : a.e.slug > b.e.slug ? 1 : 0;
    })
    .map((x) => x.e.slug);
}
