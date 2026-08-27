import {
  fetchStepDisqualifications,
  fetchStepOutcomes,
  type LeadStepOutcome,
  type StepOutcomeRow,
} from "./step-outcomes-client.js";

/**
 * WHAT A HUMAN OBSERVED, TURNED INTO WHAT THE ENGINE PRICES.
 *
 * lead-service states facts about a lead in ITS vocabulary (`meeting_booked`, `meeting_attended`,
 * `sale`, …). The revenue engine prices SIGNALS (`meeting`, `meetingAttended`, `closeWin`, …). This
 * module is the one place the two are joined, so the two vocabularies can never drift into two
 * different answers about the same lead.
 *
 * It answers three things per lead, and they are three different kinds of fact:
 *
 *   - WHICH RUNG the lead stands on, and WHEN it got there. That replaces a forecast with a fact: a
 *     lead who attended a meeting is priced on attending one, not on the chance a reply becomes one.
 *   - WHAT THE LEAD IS WORTH, when somebody said. A won deal always carries an amount, so realized
 *     revenue stops being the brand's average and becomes the money that actually changed hands.
 *   - WHICH STEPS ARE RULED OUT. A `never` is not an outcome and nothing counts it; it exists so a
 *     dead lead can be told from a pending one. The pending lead keeps the forecast its evidence
 *     earns. The dead one has no path left, and a forecast of a thing that will not happen is worth
 *     nothing.
 */

/** The producer's step vocabulary → the engine's signal. One entry per step a lead can be stated at. */
const STEP_TO_SIGNAL: Record<LeadStepOutcome, string> = {
  meeting_booked: "meeting",
  meeting_attended: "meetingAttended",
  sale: "closeWin",
  signup: "signup",
  form_submission: "formSubmission",
};

/**
 * The steps a PATH is priced on today, most advanced LAST.
 *
 * `signup` / `form_submission` are legs of their funnels and a lead can be ruled out at them, but no
 * path scores them yet (they are per-lead display outcomes served from their own counts), so stating
 * one must not silently invent a rung. They are deliberately absent here and present in the dead map.
 */
const PRICED_STEPS: readonly LeadStepOutcome[] = ["meeting_booked", "meeting_attended", "sale"];

/** Every step a `never` can be stated at, most advanced last — the order the stated VALUE is read in. */
const ALL_STEPS: readonly LeadStepOutcome[] = [
  "signup",
  "form_submission",
  "meeting_booked",
  "meeting_attended",
  "sale",
];

/** What a human observed about one lead, in the engine's own terms. */
export interface ObservedLeadFacts {
  /** signal → the ISO date the lead reached that rung (null when the outcome is genuinely undated). */
  reached: Record<string, string | null>;
  /**
   * What this lead is worth, in dollars, per the MOST ADVANCED statement that named an amount — a
   * later statement is a later truth, and the sale's amount is the money that actually moved. Null
   * when nobody said, which leaves the brand's / offer's own revenue standing.
   */
  valueUsd: number | null;
  /** The engine signals of the steps a human ruled out for this lead. */
  deadStepSignals: string[];
}

/**
 * Read every stated step for a brand and collapse it per lead, keyed by the canonical email this
 * service already joins leads on.
 *
 * Six reads, all brand-scoped and all cheap, and they are read TOGETHER on purpose: a lead's rung and
 * the fact that its funnel is dead are two halves of one answer, and fetching them apart would let a
 * transient failure price a lead on a rung its funnel no longer has.
 *
 * A row the producer could not give an email for is SKIPPED here rather than dropped upstream — the
 * producer keeps it so its own counts stay self-consistent, and we skip it because a lead we cannot
 * join is a lead we cannot price, which is not the same as one that does not exist.
 */
export async function fetchObservedStepFacts(
  brandId: string,
): Promise<Map<string, ObservedLeadFacts>> {
  const [outcomesByStep, dead] = await Promise.all([
    Promise.all(ALL_STEPS.map((step) => fetchStepOutcomes(brandId, step))).then(
      (lists) => new Map(ALL_STEPS.map((step, i) => [step, lists[i]] as const)),
    ),
    fetchStepDisqualifications(brandId),
  ]);

  const byEmail = new Map<string, ObservedLeadFacts>();
  const facts = (email: string): ObservedLeadFacts => {
    let existing = byEmail.get(email);
    if (!existing) {
      existing = { reached: {}, valueUsd: null, deadStepSignals: [] };
      byEmail.set(email, existing);
    }
    return existing;
  };

  // Ascending step order, so the most advanced statement is the last one written: it wins the value,
  // and each rung it passed keeps its own date.
  for (const step of ALL_STEPS) {
    for (const row of outcomesByStep.get(step) ?? []) {
      if (!row.email) continue;
      const entry = facts(row.email);
      if (PRICED_STEPS.includes(step)) {
        entry.reached[STEP_TO_SIGNAL[step]] = earliest(entry.reached[STEP_TO_SIGNAL[step]], row.occurredAt);
      }
      if (row.valueCents !== null) entry.valueUsd = row.valueCents / 100;
    }
  }

  for (const [step, emails] of dead) {
    const signal = STEP_TO_SIGNAL[step];
    if (!signal) continue;
    for (const email of emails) {
      const entry = facts(email);
      if (!entry.deadStepSignals.includes(signal)) entry.deadStepSignals.push(signal);
    }
  }

  return byEmail;
}

/**
 * The EARLIEST of two dates — a lead reached a rung the first time it reached it, and a restatement
 * corrects the fact rather than moving the lead forward in time. `undefined` (never seen) and `null`
 * (seen but undated) are different: an undated outcome must not overwrite a dated one, and must still
 * mark the rung as reached.
 */
function earliest(current: string | null | undefined, incoming: string | null): string | null {
  if (current === undefined || current === null) return incoming ?? current ?? null;
  if (!incoming) return current;
  return incoming < current ? incoming : current;
}

/** Test seam / reuse: the step→signal map, so nothing else re-derives the join. */
export const OBSERVED_STEP_SIGNALS = STEP_TO_SIGNAL;
