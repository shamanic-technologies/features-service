/**
 * A PIPE NO SALES FUNNEL PRICES (owner audit 2026-10-11).
 *
 * The dashboard asks the leg-keyed `workflow-projection` for EVERY ongoing campaign's pipe. Some pipes are
 * real legs of their channel (seeded `stepTransitions`) on a channel that sells no READING sales funnel:
 * the sourcing channels (`start_to_lead_found`) and AI Instant Call (`conversation_to_booking_call`, on the
 * display-only funnel). No funnel prices them, so the funnel ladder cannot answer; the route used to refuse
 * their leg (400 `leg_unrecognised` / 404 `leg_not_declared`, ~314 failed reads a day). Like every pipe
 * they run the workflows ASSIGNED to them, so the route answers with those (`unpricedPipeProjection`).
 *
 * The rule, no slug named: a leg of the channel's OWN seeded legs, on a channel whose `salesFunnels` minus
 * the display-only ones is empty. Every other leg goes through the funnel ladder; a word naming no leg of
 * the channel still fails loud.
 */
import { SEED_FEATURES } from "../seed/features.js";
import { legKeyFor } from "./funnel-legs.js";
import { DISPLAY_ONLY_SALES_FUNNELS } from "./sales-funnels.js";

const normalise = (raw: string): string => raw.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** The leg key of the unpriced pipe the caller named, or null when the channel sells a reading funnel or
 *  the word names none of its legs. */
export function unpricedPipeLeg(featureSlug: string, rawLeg: string): string | null {
  const feature = SEED_FEATURES.find((f) => f.slug === featureSlug);
  if (!feature || feature.salesFunnels.some((k) => !DISPLAY_ONLY_SALES_FUNNELS.has(k))) return null;
  const wanted = normalise(rawLeg);
  return (feature.acquisitionChannel?.stepTransitions ?? []).some((t) => legKeyFor(t) === wanted) ? wanted : null;
}
