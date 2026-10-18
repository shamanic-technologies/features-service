/**
 * THE ORDER OF THE WORKFLOWS ON ONE LEG — ONE computation, served to campaign-service (the leg-keyed
 * `workflow-projection`, per campaign: rank 1 is what runs) AND to the staff Research page
 * (`/public/stats/leg-workflow-ranking`, fleet-wide). Each read hands it its own evidence; the rule is here
 * and nowhere else (WF-ORDER-EXPLORE-1018: the two reads were two computations and disagreed).
 *
 * OWNER RULE (2026-09-30, 2026-10-01): the learning workflows still cheaper than the best mature one go
 * FIRST (they are worth exploring), then the best mature one (where the money goes), then the rest.
 *
 * A learning workflow's price is its EXPLORE PRICE: what one outcome would cost if its next outcome landed
 * now = its fleet spend on the leg ÷ max(its outcomes, 1). With outcomes it is its observed (flash) cost per
 * outcome, the figure the rule always read. With none it is its spend: a workflow that has spent less than
 * the best mature price has not yet been proven worse than it, so it is explored; one that never ran has
 * spent $0 and goes first. Self-extinguishing: once its spend passes the bar without an outcome it falls
 * below the best mature (prod 2026-10-18, cold email website-visit leg: Lyonesse mature at $0.32 per visit;
 * Aldhanab, Amansinaya, Chertan, Hamal assigned 2026-10-13 with $0 spent sat at rank 8+ and never ran).
 *
 * Within each assignment group (selectable first, then every workflow a run may not pick):
 *   1. learning workflows whose explore price is below the best mature price, cheapest first;
 *   2. the mature workflows: finest grain first (`matureTier`: a mission's offer, then brand, then fleet;
 *      the fleet view has one grain), cheapest first inside a grain. The first is the best mature one;
 *   3. the other learning workflows, cheapest explore price first.
 * With no mature workflow, every learning one is ordered by its explore price. Ties break on the slug, so
 * the order is total and the same evidence always gives the same list.
 */
export interface LegWorkflowOrderEntry {
  slug: string;
  /** A run may pick it (assigned active on the leg AND executable). Non-selectable rows sort after. */
  selectable: boolean;
  /** Its mature price on the finest grain holding one (`tier` 0 = finest), null while learning. */
  mature: { tier: number; costPerOutcomeUsd: number } | null;
  /** Its fleet evidence on the leg (flash): what prices it while it is learning. */
  fleet: { spentUsd: number; outcomes: number };
}

/** What ONE outcome would cost if the workflow's next outcome landed now. Never null: $0 for a workflow never run. */
export function explorePriceUsd(fleet: { spentUsd: number; outcomes: number }): number {
  return Math.max(fleet.spentUsd, 0) / Math.max(fleet.outcomes, 1);
}

const bySlug = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function orderGroup(group: LegWorkflowOrderEntry[]): LegWorkflowOrderEntry[] {
  const matures = group
    .filter((e) => e.mature != null)
    .sort((a, b) => a.mature!.tier - b.mature!.tier || a.mature!.costPerOutcomeUsd - b.mature!.costPerOutcomeUsd || bySlug(a.slug, b.slug));
  const learning = group
    .filter((e) => e.mature == null)
    .map((e) => ({ e, price: explorePriceUsd(e.fleet) }))
    .sort((a, b) => a.price - b.price || bySlug(a.e.slug, b.e.slug));
  const best = matures[0];
  if (!best) return learning.map((l) => l.e);
  const bar = best.mature!.costPerOutcomeUsd;
  return [...learning.filter((l) => l.price < bar).map((l) => l.e), ...matures, ...learning.filter((l) => l.price >= bar).map((l) => l.e)];
}

/** PURE. The slugs in order (see the owner rule above). */
export function orderLegWorkflows(entries: LegWorkflowOrderEntry[]): string[] {
  return [...orderGroup(entries.filter((e) => e.selectable)), ...orderGroup(entries.filter((e) => !e.selectable))].map((e) => e.slug);
}

/** PURE. The best mature workflow of the selectable group (where the money goes), null when none is mature. */
export function bestMatureSlug(entries: LegWorkflowOrderEntry[]): string | null {
  const ordered = orderGroup(entries.filter((e) => e.selectable));
  return ordered.find((e) => e.mature != null)?.slug ?? null;
}

/** Why a workflow stands where it does in the leg order (one word per rule above). */
export type LegWorkflowPlace = "explore" | "money" | "mature" | "proven_worse" | "cannot_run";

/**
 * PURE. Each workflow's place: `explore` (learning, explore price below the best mature price, or nothing is
 * mature yet), `money` (the best mature one), `mature` (the other mature ones), `proven_worse` (learning, its
 * spend already reached the best mature price), `cannot_run` (not selectable: a run may never pick it).
 */
export function legWorkflowPlaces(entries: LegWorkflowOrderEntry[]): Map<string, LegWorkflowPlace> {
  const best = bestMatureSlug(entries);
  const bar = best ? entries.find((e) => e.slug === best)!.mature!.costPerOutcomeUsd : null;
  return new Map(
    entries.map((e): [string, LegWorkflowPlace] => [
      e.slug,
      !e.selectable
        ? "cannot_run"
        : e.mature
          ? e.slug === best
            ? "money"
            : "mature"
          : bar == null || explorePriceUsd(e.fleet) < bar
            ? "explore"
            : "proven_worse",
    ]),
  );
}
