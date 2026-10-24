/**
 * LEAD STATES (owner 2026-10-24, LEAD-STATES-1024; doctrine: agent-config skill `cost-accounting`, Words + rules 2-3).
 * A lead outcome is a STATE reached ONCE per lead x brand, never an event: 3 positive replies = 1 lead interested,
 * 12 clicks = 1 lead visited. Two families, never summed:
 *   interest: lead_interested < meeting_booked < meeting_attended < paid_client (a higher state reaches the lower ones)
 *   visit:    lead_visited (implied by nothing else)
 * The cost ledger (runs-service) charges a run to the NEXT state its lead had not reached at run time, and reads here
 * which state each catalogue step reaches (`leadState` on every step row), never a map of its own. Pure.
 */
import type { ChannelStepKey } from "./acquisition-channels.js";

export const LEAD_STATES = [
  { key: "lead_interested", family: "interest", rank: 1, label: "Lead interested", icon: "hand-heart", description: "The lead showed interest: a first positive reply, or a meeting booked with no reply before it. Reached once per lead.", shortDescription: "A lead said yes, once per lead." },
  { key: "meeting_booked", family: "interest", rank: 2 },
  { key: "meeting_attended", family: "interest", rank: 3 },
  { key: "paid_client", family: "interest", rank: 4 },
  { key: "lead_visited", family: "visit", rank: 1, label: "Lead visited", icon: "eye", description: "The lead visited the website at least once (a click judged human). Reached once per lead.", shortDescription: "A lead visited the site, once per lead." },
] as const;

export type LeadStateKey = (typeof LEAD_STATES)[number]["key"];
export type LeadStateFamily = (typeof LEAD_STATES)[number]["family"];

const BY_KEY = new Map<string, (typeof LEAD_STATES)[number]>(LEAD_STATES.map((s) => [s.key, s]));

/** The lead states that are not already a coded step: added to the catalogue as steps of their own. */
export const NEW_LEAD_STATE_STEPS = LEAD_STATES.filter((s): s is Extract<(typeof LEAD_STATES)[number], { label: string }> => "label" in s);

/**
 * Which state reaching each CODED step puts the lead in. A Record over the coded keys: a new coded step fails the build
 * until it states one. A click is a visit, never interest; a yes (reply, form, signup, booking call) is interest, never a
 * visit (owner 2026-10-24: « un click c'est une visite, un oui c'est un intérêt »).
 */
export const CODED_STEP_LEAD_STATES: Readonly<Record<ChannelStepKey, LeadStateKey | null>> = {
  lead_found: null,
  conversation: "lead_interested",
  website_visit: "lead_visited",
  booking_call: "lead_interested",
  signup: "lead_interested",
  form_submitted: "lead_interested",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  purchase: "paid_client",
  paid_client: "paid_client",
};

/** The state a step reaches: a coded step's, a lead-state step's own, else null (a declared step on no state). */
export function leadStateOf(stepKey: string): LeadStateKey | null {
  if (Object.hasOwn(CODED_STEP_LEAD_STATES, stepKey)) return CODED_STEP_LEAD_STATES[stepKey as ChannelStepKey];
  return BY_KEY.has(stepKey) ? (stepKey as LeadStateKey) : null;
}

export const leadStateFamilyOf = (state: LeadStateKey | null): LeadStateFamily | null => (state ? BY_KEY.get(state)!.family : null);
export const leadStateRankOf = (state: LeadStateKey | null): number | null => (state ? BY_KEY.get(state)!.rank : null);
