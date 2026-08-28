/**
 * A FUNNEL READ STEP BY STEP — how many leads reached each rung, what reaching it cost, and what
 * share of the rung before it converted.
 *
 * The money half of a funnel answers what came back and what it cost. `outcomes` answers how much
 * evidence that rests on, but only at the two rungs every funnel shares (a website visit, a positive
 * reply). A customer opening ONE of their sales funnels asks a narrower question: walk me down MY
 * funnel, in ITS order, and tell me where people fall out. That question is per-STEP, and two of its
 * three columns had no answer anywhere on the response.
 *
 * ── WHY THIS IS SERVED RATHER THAN DIVIDED IN THE BROWSER ───────────────────────────────────────
 *
 * A displayed stat is this service's to compute. A consumer dividing two served counts would drift
 * from whatever this service computes the moment either side changes — and it would have to pick a
 * base for the FIRST step, which is exactly the decision that belongs here.
 *
 * ── ONE BASIS FOR EVERY STEP, WHICH IS WHAT MAKES THE RATES MEAN ANYTHING ───────────────────────
 *
 * Every count below is DISTINCT LEADS off the SAME deduped persons `outcomes` counts, in the SAME
 * scope, with the SAME committed cents behind every cost. That is the whole reason the block exists
 * as one builder: a chain whose rungs came from different bases (a brand-wide conversion count above
 * a funnel-scoped one) can state a conversion rate above 100% between two steps of one funnel, which
 * is not a rate at all. The counts therefore agree with `leads[]` row for row — each step names the
 * `leads[]` field it counts (`leadField`) so a reader can reconcile the two by hand.
 *
 * "MEETING ATTENDED" IS THE RUNG THIS UNLOCKS. It has a per-lead flag (a human states it; no
 * page-load tag can observe somebody showing up) and no count and no cost anywhere else — so a
 * reply-to-meeting funnel, whose chain is reply → booked → attended → paid, had a hole in the middle
 * of it. A four-step band rendering three steps and a blank is an internally-incoherent surface.
 *
 * ── COSTS ARE OBSERVED, RATES ARE MEASURED, AND NEITHER IS EVER FLOORED ─────────────────────────
 *
 * `costPerReachCents` is COMMITTED spend ÷ the step's count, through the same OBSERVED engine
 * `outcomes.cpcCents` rides — accounting, so a step nobody reached reports NULL, never 0 and never a
 * benchmark floor. Projection has its own surfaces (`/workflow-projection`), and a floor mixed into a
 * measured band is how a benchmark comes to read as a measurement. Note every step divides the SAME
 * committed total: the spend bought the whole funnel, not one rung of it, so "what did reaching this
 * step cost" is the scope's money over the people who got there.
 *
 * ── AND WHAT THE CUSTOMER SPENT ON THE RUNG THEMSELVES, BESIDE IT ───────────────────────────────
 *
 * The platform automates the first link and CHARGES for it; the customer runs the meeting and closes
 * the deal, and states what those legs cost them. That was answerable for a whole FUNNEL and nowhere
 * finer — but the question is per ARROW ("what does a booked meeting cost me?"), and one funnel-wide
 * total covers every arrow at once, so it cannot answer it. A statement already NAMES its step, so
 * `customerCost` is a partition of the same rows: the funnel-wide figure is byte-unchanged beside it,
 * nothing of theirs is folded into what we charged, and the average per person who crossed the rung
 * is SERVED rather than divided in a browser.
 *
 * ── ABSENT AND ZERO ARE DIFFERENT STATEMENTS ────────────────────────────────────────────────────
 *
 * `recipientsReached: 0` is MEASURED — we read the evidence and nobody got there, which is the answer
 * a customer asking "is this working?" is owed. `null` is "we could not measure this": the producer
 * behind that step's signal was unreadable on this request (the observed-step statements degrade
 * fail-soft, and the website-conversion attribution sets degrade per event), or the read never
 * fetched it at all. A null count nulls its cost and both rates that touch it, rather than letting an
 * unread rung read as a wall people never climbed.
 *
 * The block itself is null when there is no ONE funnel to walk: no funnel is wired for the channel
 * (the leads were never read), or the read is priced on several declared funnels at once — a brand
 * selling four funnels has four chains, and picking one would state a funnel the caller never asked
 * about. A read that names its funnel (`?funnel=`, or the per-funnel grain) always gets its chain,
 * priced or not: "we could not price this" and "this reached nobody" are different statements, and
 * the volume half is measurable either way.
 */
import { observedCostPerOutcome } from "./cost-engine.js";
import { coverageOf, type CustomerDeclaredCost, type FunnelCostCoverage } from "./funnel-customer-costs.js";
import { FUNNEL_LEG_SIGNALS } from "./funnel-registry.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";

/** The `leads[]` boolean each funnel leg counts — the field a consumer reconciles a step against. */
export type LeadStepField =
  | "clicked"
  | "repliedPositive"
  | "meetingBooked"
  | "meetingAttended"
  | "signup"
  | "formSubmission"
  | "purchased";

/**
 * The engine signal a funnel leg is evidenced by → the `leads[]` field carrying it.
 *
 * Every leg in `FUNNEL_LEG_SIGNALS` must appear here. A leg added there without an entry FAILS LOUD
 * rather than silently dropping a step out of the middle of somebody's funnel.
 */
const LEG_SIGNAL_TO_LEAD_FIELD: Record<string, LeadStepField> = {
  clicked: "clicked",
  positiveReply: "repliedPositive",
  meeting: "meetingBooked",
  meetingAttended: "meetingAttended",
  signup: "signup",
  formSubmission: "formSubmission",
  closeWin: "purchased",
};

/** The `EnginePerson.signals` key each lead field is read from. The engine's own vocabulary. */
const LEAD_FIELD_TO_SIGNAL: Record<LeadStepField, string> = {
  clicked: "clicked",
  repliedPositive: "positiveReply",
  meetingBooked: "meeting",
  meetingAttended: "meetingAttended",
  signup: "signup",
  formSubmission: "formSubmission",
  purchased: "closeWin",
};

/**
 * The `leads[]` field a customer STATEMENT lands on — lead-service's step vocabulary, reversed.
 *
 * Only the legs a HUMAN works are in it. Nobody is ever asked what a website visit or a positive
 * reply cost them: the platform automates those and BILLS for them, so their cost is the charged
 * spend beside this, and a rung with no entry here reports an empty statement set rather than a hole.
 */
const STEP_COST_STEP_TO_LEAD_FIELD: Record<string, LeadStepField> = {
  meeting_booked: "meetingBooked",
  meeting_attended: "meetingAttended",
  sale: "purchased",
  signup: "signup",
  form_submission: "formSubmission",
};

/** The producer step each lead field is stated at, or undefined for a leg nobody states a cost for. */
const LEAD_FIELD_TO_STEP_COST_STEP: Partial<Record<LeadStepField, string>> = Object.fromEntries(
  Object.entries(STEP_COST_STEP_TO_LEAD_FIELD).map(([step, field]) => [field, step]),
) as Partial<Record<LeadStepField, string>>;

/** A funnel leg this service cannot name a lead field for — a step would silently vanish from a chain. */
export class UnknownFunnelLegSignalError extends Error {
  constructor(readonly funnelKey: SalesFunnelKey, readonly signal: string) {
    super(`sales funnel ${funnelKey} has a leg signal this service cannot count: ${signal}`);
    this.name = "UnknownFunnelLegSignalError";
  }
}

/** A funnel whose labelled steps and evidenced legs disagree — the zip below would mislabel a rung. */
export class FunnelStepShapeError extends Error {
  constructor(readonly funnelKey: SalesFunnelKey, steps: number, legs: number) {
    super(`sales funnel ${funnelKey} states ${steps} steps but ${legs} legs`);
    this.name = "FunnelStepShapeError";
  }
}

/**
 * WHICH STEP SIGNALS THIS REQUEST COULD ACTUALLY READ.
 *
 * Every flag is a fact about the READ, not about the leads: `false` means the producer behind that
 * signal degraded (or was never fetched on this path), so the rung is reported `null` instead of a
 * fabricated 0. The two engagement signals have no separate producer — they ride the core lead read,
 * which is fail-loud — so they are always measured wherever the leads were read at all.
 */
export interface StepEvidence {
  /** What a human observed: the booked / attended / closed rungs. Fail-soft on the request path. */
  observedSteps: boolean;
  /** The LEGACY instantly qualifications, which still carry real booked + closed outcomes. */
  legacyQualifications: boolean;
  /** lead-service's matched-lead email set for signups. Fail-soft per event. */
  signupAttribution: boolean;
  /** lead-service's matched-lead email set for form submissions. Fail-soft per event. */
  formSubmissionAttribution: boolean;
}

/** Every step signal readable — the nominal request, and the shape a test states when nothing degraded. */
export const ALL_STEP_EVIDENCE: StepEvidence = {
  observedSteps: true,
  legacyQualifications: true,
  signupAttribution: true,
  formSubmissionAttribution: true,
};

/** Was this step's evidence readable at all on this request? See {@link StepEvidence}. */
function measured(field: LeadStepField, evidence: StepEvidence): boolean {
  switch (field) {
    case "clicked":
    case "repliedPositive":
      // The core lead read carries these, and it is fail-loud: if we have persons, we have these.
      return true;
    case "meetingBooked":
    case "purchased":
      // TWO producers answer these and either one alone is a real answer — the statement wins where it
      // exists, the legacy qualifications fill what nobody has restated. Unmeasured only when BOTH are
      // unreadable, exactly as the overlay treats them.
      return evidence.observedSteps || evidence.legacyQualifications;
    case "meetingAttended":
      // Stated by hand only. Nothing else in the fleet can observe somebody showing up, so the
      // statements are the whole evidence and their absence is unmeasured, never zero.
      return evidence.observedSteps;
    case "signup":
      return evidence.signupAttribution;
    case "formSubmission":
      return evidence.formSubmissionAttribution;
  }
}

/**
 * WHAT THE CUSTOMER STATES ONE RUNG COST THEM, and what one crossing of it cost on average.
 *
 * NEVER folded into the charged money. Nothing here was billed, no platform cost was declared for it,
 * and none of it reaches billing — it rides BESIDE `costPerReachCents`, exactly as the funnel-wide
 * `customerCost` rides beside `costEconomics`, so a consumer renders either without inferring one
 * from the other.
 *
 * A rung nobody has ever been asked about reads zeros with `coverage: "platform_spend_only"` and a
 * NULL average — never a fabricated $0, which would say the customer's work was free. The whole block
 * is null only when the statements could not be READ at all: "we have no figure" and "it cost
 * nothing" are different answers, and a consumer acts on them differently.
 */
export interface FunnelStepCustomerCost extends CustomerDeclaredCost {
  /** Which dollars this rung's figure is made of — the per-rung twin of the funnel-wide marker. */
  coverage: FunnelCostCoverage;
  /**
   * The stated total ÷ `recipientsReached`, in cents — what ONE person crossing this rung cost the
   * customer on average. OBSERVED, through the same engine `costPerReachCents` rides: null when
   * nobody stated a cost, when nobody reached the rung, or when the count is unmeasured.
   */
  costPerReachCents: number | null;
}

/** One rung of a funnel: who reached it, what that cost, and what share of the rung before converted. */
export interface FunnelStep {
  /** The funnel's own label for this step, in brand-service's words (`SALES_FUNNELS[key].steps`). */
  step: string;
  /** The `leads[]` boolean this step counts, so a consumer can reconcile it against the rows. */
  leadField: LeadStepField;
  /**
   * DISTINCT leads that reached this step. 0 is MEASURED ("nobody got here"); null is "we could not
   * measure this" — the producer behind this step's signal degraded or was never read.
   */
  recipientsReached: number | null;
  /**
   * COMMITTED spend ÷ `recipientsReached`, in cents — OBSERVED, never floored to a benchmark. Null
   * when nobody reached the step, when nothing was spent, or when the count is unmeasured.
   */
  costPerReachCents: number | null;
  /** The step this one converts FROM: the previous rung of the funnel, or "Contacted" for the first. */
  fromStep: string;
  /** Distinct leads that reached `fromStep` — the base of the rate below. Same null rule. */
  fromRecipientsReached: number | null;
  /**
   * `recipientsReached ÷ fromRecipientsReached × 100`. Null when either side is unmeasured, or when
   * the base is 0 (no denominator — never a fabricated 0% or 100%).
   */
  conversionFromPreviousPct: number | null;
  /**
   * What the CUSTOMER states this rung cost them, and the average per person who crossed it. Null
   * when the statements could not be read at all (or were never fetched on this path) — a rung
   * nobody has stated a cost for reads zeros instead. See {@link FunnelStepCustomerCost}.
   */
  customerCost: FunnelStepCustomerCost | null;
}

/** One funnel, walked step by step. See the module header for every rule behind it. */
export interface FunnelStepBreakdown {
  funnelKey: SalesFunnelKey;
  /** The funnel's own name, so a consumer renders the chain without holding the catalogue. */
  name: string;
  /** COMMITTED cents behind every `costPerReachCents` — the one basis `costEconomics` rides. */
  committedSpentCents: number;
  /**
   * DISTINCT leads this scope contacted — the base the FIRST step converts from, and the reason that
   * step's rate is answerable at all. Always measured wherever the leads were read.
   */
  contactedRecipients: number;
  /** The funnel's rungs, in the funnel's own order, first to last. */
  steps: FunnelStep[];
}

/** The label the first step converts from — outreach, which is a step of no funnel but the base of all. */
const CONTACTED_LABEL = "Contacted";

/**
 * PURE: walk ONE funnel's rungs over one scope's persons and its committed cents.
 *
 * Dedup FIRST, on the engine's own rule, so a lead served twice inside this scope is one person — the
 * same rule `outcomes` and the brand read's `recipients*` series apply, which is what makes the three
 * agree by construction rather than by correction.
 */
export function buildFunnelSteps(
  funnelKey: SalesFunnelKey,
  persons: EnginePerson[],
  committedSpentCents: number,
  evidence: StepEvidence,
  /**
   * The customer's own statements for THIS scope, already partitioned by the producer's step word
   * (`lib/funnel-customer-costs.ts` `customerCostsByStep`). `null` — the default — is "we could not
   * read them, or this path never fetched them", which is why every rung's `customerCost` is null
   * rather than zero: absent is absent.
   */
  customerCostsByStep: Record<string, CustomerDeclaredCost> | null = null,
): FunnelStepBreakdown {
  const def = SALES_FUNNELS[funnelKey];
  const legs = FUNNEL_LEG_SIGNALS[funnelKey];
  // The labels and the legs are two mirrors of one catalogue. If they ever stop lining up, every rung
  // after the divergence carries the wrong name — a silent mislabel, so it fails loud instead.
  if (def.steps.length !== legs.length) throw new FunnelStepShapeError(funnelKey, def.steps.length, legs.length);

  const deduped = dedupPersonsByLead(persons);
  const contactedRecipients = deduped.reduce((n, p) => n + (p.signals.contacted ? 1 : 0), 0);

  const steps: FunnelStep[] = [];
  let fromStep = CONTACTED_LABEL;
  let fromRecipientsReached: number | null = contactedRecipients;

  for (const [i, signal] of legs.entries()) {
    const leadField = LEG_SIGNAL_TO_LEAD_FIELD[signal];
    if (!leadField) throw new UnknownFunnelLegSignalError(funnelKey, signal);

    const personSignal = LEAD_FIELD_TO_SIGNAL[leadField];
    const recipientsReached = measured(leadField, evidence)
      ? deduped.reduce((n, p) => n + (p.signals[personSignal] ? 1 : 0), 0)
      : null;

    // The statements made on THIS rung. A leg the platform works has no producer step at all, so it
    // reads the same empty set as one nobody has been asked about yet — both are "no figure stated",
    // which is exactly what `platform_spend_only` says.
    const stated = customerCostsByStep
      ? customerCostsByStep[LEAD_FIELD_TO_STEP_COST_STEP[leadField] ?? ""] ?? {
          costCents: 0,
          statedCount: 0,
          unstatedCount: 0,
        }
      : null;

    steps.push({
      step: def.steps[i],
      leadField,
      recipientsReached,
      customerCost: stated
        ? {
            ...stated,
            coverage: coverageOf(stated),
            // The SAME observed engine the charged cost per reach rides, so the two halves of a
            // rung's money are null under the same conditions and can never disagree about whether
            // this rung was measurable at all.
            costPerReachCents:
              recipientsReached === null ? null : observedCostPerOutcome(stated.costCents, recipientsReached),
          }
        : null,
      costPerReachCents:
        recipientsReached === null ? null : observedCostPerOutcome(committedSpentCents, recipientsReached),
      fromStep,
      fromRecipientsReached,
      conversionFromPreviousPct:
        recipientsReached === null || fromRecipientsReached === null || fromRecipientsReached === 0
          ? null
          : (recipientsReached / fromRecipientsReached) * 100,
    });

    fromStep = def.steps[i];
    fromRecipientsReached = recipientsReached;
  }

  return { funnelKey, name: def.name, committedSpentCents, contactedRecipients, steps };
}

/**
 * WHICH funnel's chain this read walks, or null when there is not exactly one.
 *
 * A read that NAMES a funnel walks it whether or not the brand declared it — the volume half is a
 * measured fact about people, and it does not wait on the terms we would need to price them. Without
 * a named funnel the chain is the read's own only when it is priced on exactly ONE declared funnel;
 * a brand selling several has several chains, and picking one would answer a question nobody asked.
 */
export function funnelForSteps(
  requested: SalesFunnelKey | undefined,
  pricedFunnelKeys: readonly SalesFunnelKey[],
): SalesFunnelKey | null {
  if (requested) return requested;
  return pricedFunnelKeys.length === 1 ? pricedFunnelKeys[0] : null;
}
