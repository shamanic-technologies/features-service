import {
  fetchStepDisqualifications,
  fetchStepOutcomes,
  type LeadStepOutcome,
  type StepOutcomeRow,
} from "./step-outcomes-client.js";
import {
  DEFAULT_PRICED_CAUSES,
  causeOf,
  zeroCauseTally,
  type OutcomeCause,
} from "./outcome-cause.js";

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
 *
 * ── WHOSE WIN IT WAS ────────────────────────────────────────────────────────────────────────────
 *
 * A statement now also carries WHO caused the outcome (`lib/outcome-cause.ts`), and this is the ONE
 * place the answer is acted on. Every row reaches its RUNG — the outcome happened, and every count,
 * rate and funnel step counts it. What the cause decides is whether the rung is PRICED: a rung only
 * rows of an unpriced state reached is listed in `unpricedSignals`, and only a PRICED row's stated
 * amount becomes the lead's value. Filtering the value at the row is what keeps the two coherent: a
 * deal we did not cause must not scale the ladder of a lead priced on our outreach.
 *
 * Not pricing the rung is deliberately NOT the same as stating a `never`. The customer said our outreach
 * did not cause this deal; they did not say the person will never buy through us, and inventing a
 * disqualification from a cause answer would put words in their mouth. The mechanism for "it will
 * never happen" exists and is a statement a human makes.
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

/** How many stated outcomes sit in each of the three cause states, per step. */
export type OutcomeCauseCounts = Record<OutcomeCause, Record<LeadStepOutcome, number>>;

/** What this brand's statements say, and how much of it each cause state accounts for. */
export interface ObservedStepFacts {
  /** Per-lead facts, keyed by the canonical email this service joins on — EVERY row, priced or not. */
  byEmail: Map<string, ObservedLeadFacts>;
  /**
   * EVERY stated outcome this read saw, tallied by cause state and step — the filter is NOT applied
   * here on purpose. A consumer that is leaving a state out has to be able to say how much it left
   * out, and a surface that cannot distinguish "nobody was asked" from "there were none" leaves a
   * reader to guess why a figure looks the way it does. Brand-scoped, exactly like the read it comes
   * from. The five priced/statable steps only; the legacy instantly qualifications are a different
   * producer and carry no cause, so nothing here counts them.
   */
  causeCounts: OutcomeCauseCounts;
}

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
  /** The rungs in `reached` that NO priced row reached — counted, never priced. */
  unpricedSignals: string[];
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
  /** WHICH CAUSE STATES are PRICED. Every state is always COUNTED. Default: our own wins only. */
  pricedCauses: readonly OutcomeCause[] = DEFAULT_PRICED_CAUSES,
): Promise<ObservedStepFacts> {
  const [outcomesByStep, dead] = await Promise.all([
    Promise.all(ALL_STEPS.map((step) => fetchStepOutcomes(brandId, step))).then(
      (lists) => new Map(ALL_STEPS.map((step, i) => [step, lists[i]] as const)),
    ),
    fetchStepDisqualifications(brandId),
  ]);

  const priced = new Set<OutcomeCause>(pricedCauses);
  // Per lead, the rungs at least one PRICED row reached; everything else it reached is unpriced.
  const pricedReached = new Map<string, Set<string>>();
  const causeCounts = zeroCauseTally(
    () => Object.fromEntries(ALL_STEPS.map((s) => [s, 0])) as Record<LeadStepOutcome, number>,
  );

  const byEmail = new Map<string, ObservedLeadFacts>();
  const facts = (email: string): ObservedLeadFacts => {
    let existing = byEmail.get(email);
    if (!existing) {
      existing = { reached: {}, valueUsd: null, deadStepSignals: [], unpricedSignals: [] };
      byEmail.set(email, existing);
    }
    return existing;
  };

  // Ascending step order, so the most advanced statement is the last one written: it wins the value,
  // and each rung it passed keeps its own date.
  for (const step of ALL_STEPS) {
    for (const row of outcomesByStep.get(step) ?? []) {
      // Tallied BEFORE anything is skipped: the counts state what exists, the filter states what was
      // counted, and a reader needs both to understand the figure above them.
      const cause = causeOf(row.causedByOutreach);
      causeCounts[cause][step] += 1;
      if (!row.email) continue;
      const entry = facts(row.email);
      const isPriced = priced.has(cause);
      if (PRICED_STEPS.includes(step)) {
        const signal = STEP_TO_SIGNAL[step];
        entry.reached[signal] = earliest(entry.reached[signal], row.occurredAt);
        if (isPriced) {
          let set = pricedReached.get(row.email);
          if (!set) pricedReached.set(row.email, (set = new Set()));
          set.add(signal);
        }
      }
      if (isPriced && row.valueCents !== null) entry.valueUsd = row.valueCents / 100;
    }
  }

  // Also the website conversions: their rungs are set by another read (the matched-lead email sets),
  // but their cause rides these rows, so a form submission that was not ours is not priced either.
  const CAUSE_ONLY_STEPS: readonly LeadStepOutcome[] = ["signup", "form_submission"];
  const causeOnlyPriced = new Map<string, Set<string>>();
  const causeOnlySeen = new Map<string, Set<string>>();
  for (const step of CAUSE_ONLY_STEPS) {
    for (const row of outcomesByStep.get(step) ?? []) {
      if (!row.email) continue;
      const signal = STEP_TO_SIGNAL[step];
      const seen = causeOnlySeen.get(row.email) ?? new Set<string>();
      seen.add(signal);
      causeOnlySeen.set(row.email, seen);
      if (priced.has(causeOf(row.causedByOutreach))) {
        const p = causeOnlyPriced.get(row.email) ?? new Set<string>();
        p.add(signal);
        causeOnlyPriced.set(row.email, p);
      }
    }
  }

  for (const [email, entry] of byEmail) {
    const pricedSet = pricedReached.get(email);
    for (const signal of Object.keys(entry.reached)) {
      if (!pricedSet?.has(signal)) entry.unpricedSignals.push(signal);
    }
    for (const signal of causeOnlySeen.get(email) ?? []) {
      if (!causeOnlyPriced.get(email)?.has(signal)) entry.unpricedSignals.push(signal);
    }
  }

  // A lead that WENT COLD at a step (lead-service's rule, CRM-connected brands only) is priced exactly
  // like one a human ruled out there: it did not convert, and a forecast of the step it stalled before
  // is worth nothing. Pricing only — it reaches no rung and leaves every count and measured rate alone.
  for (const source of [dead.byStep, dead.coldByStep]) {
    for (const [step, emails] of source) {
      const signal = STEP_TO_SIGNAL[step];
      if (!signal) continue;
      for (const email of emails) {
        const entry = facts(email);
        if (!entry.deadStepSignals.includes(signal)) entry.deadStepSignals.push(signal);
      }
    }
  }

  return { byEmail, causeCounts };
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
