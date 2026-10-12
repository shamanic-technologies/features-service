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
import { loadChannelCatalogue } from "./channel-declarations-store.js";
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

/**
 * A PUBLISHED leg of the channel that no sales funnel walks (owner 2026-10-12, FORM-SUBMITTED-TRIGGER-1012): a
 * leg declared at run time on a channel that does sell reading funnels, e.g. AI Meeting Booking's
 * `form_submitted_to_meeting_booked`. Like an unpriced pipe it runs its ASSIGNED workflows. Read only when the
 * word names no funnel leg (`matchChannelLegKey` missed), so the funnel path pays nothing for it. Null = the
 * channel publishes no such leg (the caller still fails loud).
 */
export async function publishedPipeLeg(featureSlug: string, rawLeg: string): Promise<string | null> {
  const wanted = normalise(rawLeg);
  const { channels } = await loadChannelCatalogue({ publishedOnly: true });
  const channel = channels.find((c) => c.slug === featureSlug);
  return channel?.stepTransitions.some((t) => t.legKey === wanted) ? wanted : null;
}
