/**
 * WHAT STARTS A REACTIVE SALES FUNNEL, in customer words (owner 2026-10-10/11: the Campaigns page shows it as a
 * tag, e.g. "Positive replies"). Read by the catalogue funnel rows and the funnel campaign read. The one-sentence
 * funnel description shipped 2026-10-11 was withdrawn by the owner the same day (the page shows the funnel's
 * path instead); its stored column `sales_path_combination_names.description` stays, unused.
 */
import type { CatalogueFunnel } from "./agent-catalogue.js";
import { triggerForStep } from "./channel-triggers.js";

/** The customer label of the trigger that starts a reactive funnel (the Campaigns page shows it as a tag). */
const TRIGGER_LABEL: Readonly<Record<string, string>> = {
  conversation: "Positive replies",
  website_visit: "Website visits",
  booking_call: "Booking calls",
  meeting_booked: "Booked meetings",
  meeting_attended: "Held meetings",
  signup: "Signups",
  form_submitted: "Form submissions",
  purchase: "Online purchases",
};

/**
 * PURE: the trigger label of a funnel whose first pipe is reactive; null on a proactive funnel. A pipe answering a
 * trigger OTHER than its step's own (a `reported` one, "Follow-up Due"; a `delay` one) reads that trigger's name, so
 * the tag never says "Signups" beside `trigger.name` "Follow-up Due" (2026-10-11).
 */
export function funnelTriggerLabel(
  f: Pick<CatalogueFunnel, "legs">,
  stepLabel: (key: string) => string,
  triggerName: (id: string) => string | null,
): string | null {
  const first = f.legs[0]?.pipe;
  if (!first || first.mode !== "reactive") return null;
  // A reactive pipe out of Start answers a step-less trigger ("Email Pushed Via API"): its name.
  if (first.fromStep === null) return first.triggerId !== null ? triggerName(first.triggerId) : null;
  if (first.triggerId !== null && first.triggerId !== triggerForStep(first.fromStep as Parameters<typeof triggerForStep>[0])?.id) {
    const name = triggerName(first.triggerId);
    if (name) return name;
  }
  return TRIGGER_LABEL[first.fromStep] ?? `${stepLabel(first.fromStep)}s`;
}
