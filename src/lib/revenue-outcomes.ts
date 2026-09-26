/**
 * THE VOLUME HALF OF A MONEY ANSWER — how much real outcome evidence the money rests on.
 *
 * Every `/revenue` grain answers what came back and what it cost. On its own that is a ratio a
 * customer reads as a measurement, and with one or two outcomes behind it the ratio is decided by
 * whichever one happened to land: it swings by whole multiples on the next reply. So each grain also
 * answers what the money was MADE of — how many people it reached, how many visited the site, how
 * many replied positively, what each of those cost, and the committed dollars behind all of it.
 *
 * ONE implementation, shared by every grain that answers it (the per-workflow groups and the
 * per-campaign groups today), for the same reason `signal-overlays.ts` is one copy: two grains
 * counting people two ways would eventually disagree about whether a lead clicked.
 *
 * ── THE RULES, WHICH ARE THE BRAND READ'S OWN ───────────────────────────────────────────────────
 *
 * REACH AND THE PIPELINE BASE ARE TWO DIFFERENT QUESTIONS, AND BOTH ARE ANSWERED HERE.
 * `recipientsContacted` is how many unique people this grain emailed — a fact about our own sending
 * and our own spend, so it counts the ones whose mailbox bounced and the ones who later unsubscribed.
 * `recipientsConvertible` is how many of them can still convert, which is the base every pipeline and
 * expected-value figure rests on. Neither is inferable from the other by a consumer (a lead can be
 * both bounced and unsubscribed, so the difference is a set union, not a subtraction), which is why
 * both are served.
 *
 * COUNTS ARE DISTINCT LEADS, deduped by the engine's own `dedupPersonsByLead` and read off the SAME
 * per-lead signals the brand read's `recipientsContacted` / `recipientsClicked` /
 * `recipientsRepliesPositive` series are built from. So a grain covering the brand's whole evidence
 * reads the brand's own figure, by construction — and a lead served twice inside one grain (two
 * versions of a workflow, two campaign rows of one identity) is ONE person, its signals OR'd
 * together, exactly as the brand read treats it. Across several groups the counts do NOT sum to the
 * brand: a lead worked under two workflows, or under two campaign identities, is one lead to the
 * brand and belongs to both groups. That is a property of counting people, not an error to correct.
 *
 * 0 IS A MEASURED COUNT — "this reached nobody" is an answer, and it is the one a customer asking
 * "is this working?" is owed.
 *
 * THE TWO RATES ARE OBSERVED — accounting, "what did this cost". A grain with spend and no outcome
 * of a kind reports NULL for that kind's rate ("we could not measure this"), never 0 and never
 * floored to a benchmark. Projection has its own surfaces (`/workflow-projection`), and mixing a
 * projected rate into a measured block is how a floor comes to read as a measurement.
 *
 * EVERY FIGURE RIDES COMMITTED SPEND — the single basis `costEconomics` rides service-wide, so
 * `cpcCents × recipientsClicked ≈ committedSpentCents` by construction and a grain's ROI and its
 * cost per click are two views of one number. `actualSpentCents` (billed-only) stays REPORTED for
 * the consumer transition and is divided by nowhere.
 */
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { observedCostPerOutcome } from "./cost-engine.js";
import type { RunsCostCents } from "./runs-cost-client.js";
import type { MaturityReason } from "./cost-economics.js";
import { basisCost, basisDays, basisPersons, basisUnmeasuredReason, type RatioBasis } from "./ratio-basis.js";

/**
 * WHAT THE TWO RATES DIVIDE — the ROI's own basis (`lib/ratio-basis.ts`), stated so a reader
 * reconciles `cpcCents = committedSpentCents ÷ recipientsClicked` from served totals. Equal to the
 * block's whole-history figures when `maturityDays` is 0; the MATURE cohort's otherwise (spend old
 * enough to have produced its outcomes, and the distinct leads that spend reached). Every figure null
 * when `unmeasuredReason` is set.
 */
export interface OutcomesRatioBasis {
  maturityDays: number;
  committedSpentCents: number | null;
  recipientsClicked: number | null;
  recipientsRepliesPositive: number | null;
  unmeasuredReason: MaturityReason | null;
}

/** The volume half of one grain's answer. See the module header for every rule behind it. */
export interface RevenueOutcomes {
  /**
   * REACH — distinct leads this grain emailed, INCLUDING every one that bounced or unsubscribed. It is
   * a fact about our own sending and our own spend: we queued the email, we sent it, we paid for it.
   * The grain-level twin of `recipientsContacted.total`.
   */
  recipientsContacted: number;
  /**
   * THE PIPELINE BASE — distinct leads still able to convert: `recipientsContacted` minus everyone a
   * bounce or an unsubscribe has taken out of the funnel. Every expected-value figure on this grain
   * rests on these people and no others.
   *
   * It is SERVED rather than left to the consumer because it is NOT derivable from the three counts
   * beside it: a lead can be both bounced and unsubscribed, so `contacted − bounced − unsubscribed`
   * double-subtracts it. Only the per-lead set knows the union.
   */
  recipientsConvertible: number;
  /** Distinct leads whose email BOUNCED. Counted as reached (a bounce is the proof a send happened). */
  recipientsBounced: number;
  /** Distinct leads who UNSUBSCRIBED. Counted as reached — we did email them, they asked us to stop. */
  recipientsUnsubscribed: number;
  /** Distinct leads that visited the site. Twin of `recipientsClicked.total`. */
  recipientsClicked: number;
  /** Distinct leads that replied positively. Twin of `recipientsRepliesPositive.total`. */
  recipientsRepliesPositive: number;
  /** COMMITTED spend attributed to this grain, in cents — `costEconomics.committedCostUsd` in the unit the two rates below are denominated in. */
  committedSpentCents: number;
  /** Billed-only spend for this grain, in cents. TRANSITIONAL — reported, divided by nowhere. */
  actualSpentCents: number;
  /**
   * Committed spend ÷ website visits, on `ratioBasis` (the ROI's mature cohort). Null when the basis
   * bought no visit, spent nothing, or is unmeasurable.
   */
  cpcCents: number | null;
  /** Committed spend ÷ positive replies, on `ratioBasis`. Same null rules. */
  cpprCents: number | null;
  /** The totals the two rates above divide. See {@link OutcomesRatioBasis}. */
  ratioBasis: OutcomesRatioBasis;
}

/**
 * PURE: the volume half for ONE grain's persons + its realized cents.
 *
 * Dedup FIRST, on the engine's own rule. The counts then read straight off the deduped signals
 * rather than off the engine's `leads[]`, so they survive the no-economics path where the engine is
 * never run at all. Where the engine IS run the two agree by construction: a contacted lead always
 * reaches a delivery milestone and a lead carrying any conversion signal scores above zero, so every
 * lead counted here is a row there.
 */
export function buildRevenueOutcomes(
  persons: EnginePerson[],
  cost: RunsCostCents,
  /** The ROI's basis (`lib/ratio-basis.ts`). Omitted → the whole scope, byte-identical to before. */
  basis?: RatioBasis,
): RevenueOutcomes {
  const deduped = dedupPersonsByLead(persons);
  let recipientsContacted = 0;
  let recipientsConvertible = 0;
  let recipientsBounced = 0;
  let recipientsUnsubscribed = 0;
  let recipientsClicked = 0;
  let recipientsRepliesPositive = 0;
  for (const person of deduped) {
    const outOfFunnel = Boolean(person.signals.bounced) || Boolean(person.signals.unsubscribed);
    if (person.signals.contacted) {
      recipientsContacted += 1;
      // The UNION, counted per person — which is exactly why this cannot be subtracted downstream.
      if (!outOfFunnel) recipientsConvertible += 1;
    }
    if (person.signals.bounced) recipientsBounced += 1;
    if (person.signals.unsubscribed) recipientsUnsubscribed += 1;
    if (person.signals.clicked) recipientsClicked += 1;
    if (person.signals.positiveReply) recipientsRepliesPositive += 1;
  }
  return {
    recipientsContacted,
    recipientsConvertible,
    recipientsBounced,
    recipientsUnsubscribed,
    recipientsClicked,
    recipientsRepliesPositive,
    committedSpentCents: cost.committedCents,
    actualSpentCents: cost.actualCents,
    ...ratesOnBasis(persons, cost, basis),
  };
}

/** The two rates, on the ROI's basis, and the totals they divide. OBSERVED, never floored. */
function ratesOnBasis(
  persons: EnginePerson[],
  cost: RunsCostCents,
  basis: RatioBasis | undefined,
): Pick<RevenueOutcomes, "cpcCents" | "cpprCents" | "ratioBasis"> {
  const unmeasuredReason = basisUnmeasuredReason(basis, cost);
  const spend = basisCost(basis, cost);
  const cohort = basisPersons(basis, cost, persons);
  if (!spend || !cohort) {
    return {
      cpcCents: null,
      cpprCents: null,
      ratioBasis: {
        maturityDays: basisDays(basis),
        committedSpentCents: null,
        recipientsClicked: null,
        recipientsRepliesPositive: null,
        unmeasuredReason,
      },
    };
  }
  const deduped = dedupPersonsByLead(cohort);
  const clicked = deduped.reduce((n, p) => n + (p.signals.clicked ? 1 : 0), 0);
  const replied = deduped.reduce((n, p) => n + (p.signals.positiveReply ? 1 : 0), 0);
  return {
    // OBSERVED, never floored: null is "this grain bought none of these", not "$0 each".
    cpcCents: observedCostPerOutcome(spend.committedCents, clicked),
    cpprCents: observedCostPerOutcome(spend.committedCents, replied),
    ratioBasis: {
      maturityDays: basisDays(basis),
      committedSpentCents: spend.committedCents,
      recipientsClicked: clicked,
      recipientsRepliesPositive: replied,
      unmeasuredReason,
    },
  };
}
