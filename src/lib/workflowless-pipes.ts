/**
 * A PIPE THAT RUNS NO WORKFLOW (owner audit 2026-10-11).
 *
 * The dashboard asks the leg-keyed `workflow-projection` for EVERY ongoing campaign's pipe. Some pipes
 * are real legs of their channel (seeded `stepTransitions`) and sit on no sales funnel: the sourcing
 * origins (`start_to_lead_found`, a lead is found on demand, no workflow ladder) and AI Instant Call
 * (`conversation_to_booking_call`, event-triggered, display only). The route used to refuse their leg
 * as unknown (400 `leg_unrecognised`): ~314 failed reads in a day, for a question whose honest answer
 * is "there is no workflow to rank here". That answer is now a 200 (`noWorkflowPipeProjection` in the
 * route): empty rows, no recommendation, `unmeasuredReason: "no_active_workflows"`.
 *
 * The rule, no slug named: a leg of the channel's OWN seeded legs, on a channel that sells no READING
 * sales funnel (its `salesFunnels` minus the display-only ones is empty), so no funnel can price it and
 * no ladder exists. Every other leg goes through the route as before; a word naming no leg of the
 * channel still fails loud.
 */
import { SEED_FEATURES } from "../seed/features.js";
import { legKeyFor } from "./funnel-legs.js";
import { DISPLAY_ONLY_SALES_FUNNELS } from "./sales-funnels.js";

const normalise = (raw: string): string => raw.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** The leg key of the workflow-less pipe the caller named, or null when the channel sells a reading
 *  funnel or the word names none of its legs. */
export function workflowlessPipeLeg(featureSlug: string, rawLeg: string): string | null {
  const feature = SEED_FEATURES.find((f) => f.slug === featureSlug);
  if (!feature || feature.salesFunnels.some((k) => !DISPLAY_ONLY_SALES_FUNNELS.has(k))) return null;
  const wanted = normalise(rawLeg);
  return (feature.acquisitionChannel?.stepTransitions ?? []).some((t) => legKeyFor(t) === wanted) ? wanted : null;
}
