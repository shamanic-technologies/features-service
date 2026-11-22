/**
 * PURE: does an offer's business have every step of a sales path / funnel? (owner 2026-10-12)
 *
 * A funnel is only worth proposing for an offer when its business has EVERY step the funnel walks. The
 * offer states the steps it has (brand-service, `lib/offer-steps-client.ts`); the steps every business has
 * by definition (Lead found, Paid client; Start is never a path step) count as present, or every funnel
 * would be set aside. An offer that never stated its steps is unknown: nothing is set aside.
 *
 * One rule for every funnel and every channel: the path's steps are the only input.
 *
 * A campaign aimed at a Target (owner 2026-11-22, GS-STEP11-NO-CAMPAIGN-1122; a campaign = Target + start + budget +
 * brief): the business must already have the steps the campaign walks BEFORE its Target; the Target is what the
 * campaign makes, and the steps after it are where the client's own sales take it from there, never a precondition
 * (an offer whose stated steps hold no meeting read every meetings-booked funnel set aside, so the signup's ONE
 * campaign aimed at meetings booked showed "No campaign can run right now" to ~4 visitors in 10). A path that never
 * reaches the Target is checked whole. No Target = every step, as before.
 */

/** Steps every business has by definition: never asked, never missing. */
export const ALWAYS_PRESENT_STEPS: readonly string[] = ["lead_found", "paid_client"];

export interface OfferStepStatement {
  stated: boolean;
  steps: readonly string[] | null;
  /** The campaign's Target: only the steps a path walks before it are a precondition. Absent / null = every step. */
  before?: string | null;
}

/** PURE: the steps of a path the offer's business must already have (those before the Target when one is named). */
export function preconditionStepsOf(pathSteps: readonly string[], before: string | null | undefined): readonly string[] {
  if (!before) return pathSteps;
  const at = pathSteps.indexOf(before);
  return at < 0 ? pathSteps : pathSteps.slice(0, at);
}

/** The path steps the offer's business does not have, in path order. Empty when it has them all or never stated. */
export function missingStepsOf(pathSteps: readonly string[], offer: OfferStepStatement): string[] {
  if (!offer.stated) return [];
  const has = new Set([...(offer.steps ?? []), ...ALWAYS_PRESENT_STEPS]);
  return [...new Set(preconditionStepsOf(pathSteps, offer.before).filter((s) => !has.has(s)))];
}

/** PURE: split candidates into kept (every step present) and set aside (each with its missing steps), order kept. */
export function splitByOfferSteps<T>(
  items: readonly T[],
  stepsOf: (item: T) => readonly string[],
  offer: OfferStepStatement,
): { kept: T[]; setAside: Array<{ item: T; missingSteps: string[] }> } {
  const kept: T[] = [];
  const setAside: Array<{ item: T; missingSteps: string[] }> = [];
  for (const item of items) {
    const missing = missingStepsOf(stepsOf(item), offer);
    if (missing.length === 0) kept.push(item);
    else setAside.push({ item, missingSteps: missing });
  }
  return { kept, setAside };
}

/** PURE: how many set-aside items each missing step accounts for, most first, then key. */
export function setAsideCountByStep(setAside: ReadonlyArray<{ missingSteps: readonly string[] }>): Array<{ step: string; setAsideCount: number }> {
  const counts = new Map<string, number>();
  for (const s of setAside) for (const k of s.missingSteps) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()].map(([step, setAsideCount]) => ({ step, setAsideCount })).sort((a, b) => b.setAsideCount - a.setAsideCount || a.step.localeCompare(b.step));
}
