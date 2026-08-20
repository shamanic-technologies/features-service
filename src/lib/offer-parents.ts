/**
 * THE BENCHMARK FOR A READ THAT SPANS SEVERAL CHANNELS — a CHOICE of channel, never a blend.
 *
 * `fetchBrandProjectedParents` answers "what does this outcome cost through THIS channel, on the
 * cross-org best workflow for it". It is a property of ONE acquisition channel: its unit costs come
 * from that channel's fleet evidence and its `byAudience` map from that channel's send-tagged spend.
 *
 * An OFFER is sold through several channels at once, so a read at the offer grain has several such
 * benchmarks and needs one. There are only two honest ways to get there, and only one of them is
 * available:
 *
 *   - AVERAGE / merge them field by field. FORBIDDEN. Each parents object is one workflow's price on
 *     one channel; mixing two makes a cross-org PLUS cross-workflow pooled estimate, which this
 *     service does not publish (see the best-workflow section in CLAUDE.md), and the merged object
 *     would no longer be internally coherent — its cost per click would come from one channel while
 *     its cost per paid client came from another.
 *   - CHOOSE the channel that returns best and take ITS benchmark whole. That is the same rule the
 *     combined-`sales` cost already follows (`min` over the routes a sale can be won through) and the
 *     same one the brand-level per-audience read follows (`max` over the declared funnels' returns):
 *     a dollar buys the outcome through whichever route converts it best, so the offer's expected
 *     cost is the best channel's, and the object stays exactly as coherent as it was.
 *
 * BEST = the LOWEST cost per paying client, because that is the one figure every channel's benchmark
 * denominates in the same unit. A cost per outcome is denominated in each channel's OWN outcome, so
 * ranking on one would compare a click against a reply.
 *
 * A ONE-CHANNEL read picks that channel, so an offer sold through a single channel reads exactly what
 * that channel's own endpoint reads today — the equality this whole grain is required to preserve.
 */
import type { BrandProjectedParentsUsd } from "./audience-stats-brand-projection.js";

/** One channel's benchmark, tagged with the channel it belongs to. */
export interface ChannelParents {
  featureSlug: string;
  parents: BrandProjectedParentsUsd | null;
}

/**
 * The channel an offer-grain read prices against — the whole entry, so a caller can carry anything else
 * it computed alongside that channel's benchmark (a coverage block, a priced-funnel list) and keep it
 * coherent with the number it belongs to.
 *
 * @param byChannel one entry per channel that could be projected, in ANY order — the pick is
 *        deterministic regardless (ties break on the slug, ascending).
 */
export function pickBestChannel<T extends ChannelParents>(byChannel: T[]): T | null {
  const resolved = byChannel
    .filter((entry) => entry.parents !== null)
    .sort((a, b) => (a.featureSlug < b.featureSlug ? -1 : a.featureSlug > b.featureSlug ? 1 : 0));
  if (resolved.length === 0) return null;

  // Rank only the channels that state a paid-client cost. One that does not has no comparable price —
  // it is not "expensive", it is unpriced, and dropping it from the ranking is the same treatment an
  // unrankable funnel gets on /funnel-ranking (ranked last, never scored 0).
  const priced = resolved.filter((entry) => typeof entry.parents!.costPerPaidClientUsd === "number");
  if (priced.length === 0) {
    // Nothing to rank on, but a real channel's benchmark is still a real answer and strictly better
    // than none — take the first by slug so the pick stays deterministic across requests.
    return resolved[0];
  }
  return priced.reduce((best, entry) =>
    (entry.parents!.costPerPaidClientUsd as number) < (best.parents!.costPerPaidClientUsd as number) ? entry : best,
  );
}

/** The winning channel's parents object VERBATIM, or null when no channel resolved one. */
export function pickBestChannelParents(byChannel: ChannelParents[]): BrandProjectedParentsUsd | null {
  return pickBestChannel(byChannel)?.parents ?? null;
}
