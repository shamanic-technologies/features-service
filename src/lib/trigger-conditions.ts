/**
 * ONE GENERIC CONDITION TRIGGER, MANY INSTANCES (owner 2026-10-16, standard-vocabulary programme, STD-VOCAB-CONDITION-1016).
 *
 * A condition trigger "outcome X reached, still not outcome Y after N" is ONE kind (`delay`, params
 * `{afterStep, minutes|days, unlessStep}`, `lib/channel-declarations.ts` `parseDelayParams`), computed by campaign-service's
 * generic detector. Each instance (`signup_not_paid_30_min`, `signup_not_paid_24_hours`, `website_visit_no_signup_30_min`,
 * any new one) is a DECLARED ROW with its parameters, never code. Everything a reader composes out of an instance (the
 * funnel name's "who it answers", the short sentence's audience) is derived HERE from its parameters, so a new instance
 * declared through `POST /internal/declarations/trigger-types` reads right with no code change. Before this, each instance
 * had its own line in `funnel-names.ts` `TRIGGER_ANSWERS` and `funnel-short-descriptions.ts` `TRIGGER_AUDIENCE`.
 *
 * The registry is filled from every trigger read (`listTriggerTypes`, `lib/channel-declarations-store.ts`), like the
 * declared steps (`registerDeclaredSteps`). Imports nothing.
 */

/** What a condition instance states: the outcome reached, and the one it is still waiting for (absent = "nothing happened"). */
export interface TriggerCondition {
  afterStep: string;
  unlessStep: string | null;
}

const CONDITIONS = new Map<string, TriggerCondition>();

/** PURE: the condition a trigger record states, null when it is not a `delay` instance with a readable `afterStep`. */
export function conditionOfTrigger(t: { kind?: string | null; params?: Record<string, unknown> | null }): TriggerCondition | null {
  if (t.kind !== "delay" || !t.params) return null;
  const { afterStep, unlessStep } = t.params;
  if (typeof afterStep !== "string" || afterStep === "") return null;
  return { afterStep, unlessStep: typeof unlessStep === "string" && unlessStep !== "" ? unlessStep : null };
}

/** Register every condition instance of a trigger read (replaces the previous registration). */
export function registerTriggerConditions(triggers: ReadonlyArray<{ id: string; kind?: string | null; params?: Record<string, unknown> | null }>): void {
  CONDITIONS.clear();
  for (const t of triggers) {
    const c = conditionOfTrigger(t);
    if (c) CONDITIONS.set(t.id, c);
  }
}

/** The condition a trigger id names, null when it is not a condition instance (or was never read). */
export const triggerCondition = (id: string): TriggerCondition | null => CONDITIONS.get(id) ?? null;

/** Who reached a step, as the subject of a sentence ("signups"). */
const WHO_REACHED: Readonly<Record<string, string>> = {
  lead_found: "new leads",
  conversation: "buyers who replied with interest",
  website_visit: "site visitors",
  booking_call: "buyers on a booking call",
  meeting_booked: "buyers who booked a meeting",
  meeting_attended: "buyers after their meeting",
  signup: "signups",
  form_submitted: "people who filled in your form",
  purchase: "online buyers",
  paid_client: "clients",
};

/** "Still not this step", as a relative clause ("who have not paid yet"). */
const STILL_NOT: Readonly<Record<string, string>> = {
  conversation: "who have not replied yet",
  website_visit: "who did not visit your site",
  booking_call: "who were not on a call yet",
  meeting_booked: "who have not booked a meeting",
  meeting_attended: "who did not attend their meeting",
  signup: "who did not sign up",
  form_submitted: "who did not fill in your form",
  purchase: "who have not bought yet",
  paid_client: "who have not paid yet",
};

const words = (step: string): string => step.split("_").join(" ");

/**
 * PURE: who a condition instance answers, in plain words: "signups who have not paid yet", "site visitors who did not
 * sign up". A subject that already carries "who" takes "but" ("buyers who replied with interest but have not booked a
 * meeting"). A step no table names reads by its key in words. Null without a `unlessStep` (no "still not" to say).
 */
export function conditionAudience(c: TriggerCondition): string | null {
  if (c.unlessStep === null) return null;
  const who = WHO_REACHED[c.afterStep] ?? `people who reached ${words(c.afterStep)}`;
  const stillNot = STILL_NOT[c.unlessStep] ?? `who did not reach ${words(c.unlessStep)}`;
  return / who /.test(who) ? `${who} ${stillNot.replace(/^who /, "but ")}` : `${who} ${stillNot}`;
}
