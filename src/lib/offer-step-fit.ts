/**
 * PURE: does an offer's business have every step of a sales path / funnel? (owner 2026-10-12)
 *
 * A funnel is only worth proposing for an offer when its business has EVERY step the funnel walks. The
 * offer states the steps it has (brand-service, `lib/offer-steps-client.ts`); the steps every business has
 * by definition (Lead found, Paid client; Start is never a path step) count as present, or every funnel
 * would be set aside.
 *
 * An offer that never stated its steps is unknown, and unknown assumes every step EXCEPT a checkout (owner
 * 2026-10-18, CeXO): a step on the lifecycle ladder's Paid client rung other than Paid client itself (Direct
 * purchase: the buyer pays on the brand's own site, nobody talks to them) is never assumed. Such a path priced on
 * the industry checkout default (0.2% visit -> purchase, 95% purchase -> paid) won the pick for a $12,000
 * executive offer at 9.7x over its 3.79x reply path, though nobody buys that online without a call. A business
 * that sells by checkout states the step once and gets its checkout paths back, ranked as before; until then the
 * row is set aside with the checkout as its missing step, the question to ask the client.
 *
 * One rule for every funnel and every channel: the path's steps and their rungs are the only input.
 */
import { codedStepLifecycleRungOf, type StepLifecycleRung } from "./lifecycle-ladder.js";

/** Steps every business has by definition: never asked, never missing. */
export const ALWAYS_PRESENT_STEPS: readonly string[] = ["lead_found", "paid_client"];

export interface OfferStepStatement {
  stated: boolean;
  steps: readonly string[] | null;
}

/** A step's rung on the lifecycle ladder (the catalogue's; coded steps by default). */
export type StepRungOf = (step: string) => StepLifecycleRung | null;

/** A CHECKOUT: the sale itself on a step other than Paid client (its rung is Paid client). Never assumed. */
export const isCheckoutStep = (step: string, rungOf: StepRungOf = codedStepLifecycleRungOf): boolean =>
  step !== "paid_client" && rungOf(step) === "paid_client";

/** The path steps the offer's business does not have, in path order. Empty when it has them all; on an offer
 *  that never stated, only its checkout steps (never assumed). */
export function missingStepsOf(pathSteps: readonly string[], offer: OfferStepStatement, rungOf: StepRungOf = codedStepLifecycleRungOf): string[] {
  if (!offer.stated) return [...new Set(pathSteps.filter((s) => isCheckoutStep(s, rungOf)))];
  const has = new Set([...(offer.steps ?? []), ...ALWAYS_PRESENT_STEPS]);
  return [...new Set(pathSteps.filter((s) => !has.has(s)))];
}

/** PURE: split candidates into kept (every step present) and set aside (each with its missing steps), order kept. */
export function splitByOfferSteps<T>(
  items: readonly T[],
  stepsOf: (item: T) => readonly string[],
  offer: OfferStepStatement,
  rungOf: StepRungOf = codedStepLifecycleRungOf,
): { kept: T[]; setAside: Array<{ item: T; missingSteps: string[] }> } {
  const kept: T[] = [];
  const setAside: Array<{ item: T; missingSteps: string[] }> = [];
  for (const item of items) {
    const missing = missingStepsOf(stepsOf(item), offer, rungOf);
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
