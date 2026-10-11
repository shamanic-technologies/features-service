/**
 * A CAMPAIGN'S RETURN IS THE VALUE IT ADDS (owner 2026-10-11, generalised the same day; ONE formula for every
 * sales funnel campaign, proactive or reactive):
 *
 *   return = Σ over its people of (value at the step they reached − value at the step where THIS campaign took
 *            them over) ÷ the campaign's own spend
 *
 *   - Its people = the people its units served (they found them) ∪ the people its units ACTED on (lead-service's
 *     follow-up ledger: a reactive unit answers people another campaign found).
 *   - The takeover step = the first step of the funnel's path, unless one of the campaign's OWN units produces it
 *     (a sourcing unit produces Lead found): then the campaign took them from nothing, start value $0, and the
 *     figure is the engine's ordinary pipeline. Bliss (its sourcing units inside it) is unchanged by
 *     construction; Motivate (answers Positive replies Bliss produced) is credited only what it adds on top.
 *   - A value is the revenue engine's own (`expectedValueOfPerson` on the offer's terms). The value of a person
 *     AT a step is the same person, same stated value, holding only that step's signal. A step the engine
 *     prices nothing at (Lead found: a lead nobody has engaged is worth $0 to the pipeline) starts at $0.
 *
 * Worked example (owner's): Motivate books 2 meetings off positive replies; a booked meeting is worth $400, a
 * positive reply $150. Value added = 2 × ($400 − $150) = $500; on $10 spent, 50x. A replier it answered who did
 * not book still holds $150: adds $0. Pure.
 */
import { expectedValueOfPerson, type EnginePerson } from "./revenue-engine.js";
import type { ResolvedPath } from "./revenue-engine.js";

/** The engine signal a person carries once they reached a step. Lead found has none (priced at $0). */
export const STEP_SIGNAL: Readonly<Record<string, string>> = {
  conversation: "positiveReply",
  website_visit: "clicked",
  meeting_booked: "meeting",
  signup: "signup",
  form_submitted: "formSubmission",
  paid_client: "closeWin",
};

/** One unit leg of a campaign: the step it starts from (null = from nothing) and the step it produces. */
export interface UnitLegSteps {
  fromStep: string | null;
  toStep: string;
}

/**
 * PURE: the step where the campaign took its people over. The path's first step (`firstStep`, null = the path
 * starts from nothing), unless one of the campaign's own units produces it: then null (from nothing).
 */
export function takeoverStepOf(firstStep: string | null, units: readonly UnitLegSteps[]): string | null {
  if (firstStep === null) return null;
  return units.some((u) => u.toStep === firstStep) ? null : firstStep;
}

/** PURE: a person as the engine would see them having reached ONLY `step` (same stated value, nothing lost). */
export function personAtStep(p: EnginePerson, step: string): EnginePerson | null {
  const signal = STEP_SIGNAL[step];
  if (!signal) return null;
  return { ...p, signals: { contacted: true, [signal]: true }, signalDates: {}, deadSignals: undefined, unpricedSignals: undefined };
}

export interface ValueAdded {
  people: number;
  valueNowUsd: number;
  valueAtTakeoverUsd: number;
  valueAddedUsd: number;
}

/** PURE: the value a campaign added over its people (deduped by lead), on the engine's paths and lifetime revenue. */
export function valueAdded(persons: readonly EnginePerson[], takeoverStep: string | null, paths: ResolvedPath[], ltr: number): ValueAdded {
  let now = 0;
  let start = 0;
  const seen = new Set<string>();
  for (const p of persons) {
    if (seen.has(p.leadId)) continue;
    seen.add(p.leadId);
    now += expectedValueOfPerson(p, paths, ltr);
    const atStart = takeoverStep ? personAtStep(p, takeoverStep) : null;
    if (atStart) start += expectedValueOfPerson(atStart, paths, ltr);
  }
  return { people: seen.size, valueNowUsd: now, valueAtTakeoverUsd: start, valueAddedUsd: now - start };
}

/** PURE: how many of the people reached `step` (the unit's outcome), for the maturity verdict. Null = no reading. */
export function reachedCount(persons: readonly EnginePerson[], step: string, actedIsTheOutcome: boolean): number | null {
  if (actedIsTheOutcome) return new Set(persons.map((p) => p.leadId)).size;
  const signal = STEP_SIGNAL[step];
  if (!signal) return null;
  return new Set(persons.filter((p) => p.signals[signal]).map((p) => p.leadId)).size;
}
