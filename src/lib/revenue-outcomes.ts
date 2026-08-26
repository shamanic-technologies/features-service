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

/** The volume half of one grain's answer. See the module header for every rule behind it. */
export interface RevenueOutcomes {
  /** Distinct leads this grain reached. The grain-level twin of `recipientsContacted.total`. */
  recipientsContacted: number;
  /** Distinct leads that visited the site. Twin of `recipientsClicked.total`. */
  recipientsClicked: number;
  /** Distinct leads that replied positively. Twin of `recipientsRepliesPositive.total`. */
  recipientsRepliesPositive: number;
  /** COMMITTED spend attributed to this grain, in cents — `costEconomics.committedCostUsd` in the unit the two rates below are denominated in. */
  committedSpentCents: number;
  /** Billed-only spend for this grain, in cents. TRANSITIONAL — reported, divided by nowhere. */
  actualSpentCents: number;
  /** Committed spend ÷ website visits. Null when this grain bought no visit, or spent nothing. */
  cpcCents: number | null;
  /** Committed spend ÷ positive replies. Null when this grain bought no reply, or spent nothing. */
  cpprCents: number | null;
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
export function buildRevenueOutcomes(persons: EnginePerson[], cost: RunsCostCents): RevenueOutcomes {
  const deduped = dedupPersonsByLead(persons);
  let recipientsContacted = 0;
  let recipientsClicked = 0;
  let recipientsRepliesPositive = 0;
  for (const person of deduped) {
    if (person.signals.contacted) recipientsContacted += 1;
    if (person.signals.clicked) recipientsClicked += 1;
    if (person.signals.positiveReply) recipientsRepliesPositive += 1;
  }
  return {
    recipientsContacted,
    recipientsClicked,
    recipientsRepliesPositive,
    committedSpentCents: cost.committedCents,
    actualSpentCents: cost.actualCents,
    // OBSERVED, never floored: null is "this grain bought none of these", not "$0 each".
    cpcCents: observedCostPerOutcome(cost.committedCents, recipientsClicked),
    cpprCents: observedCostPerOutcome(cost.committedCents, recipientsRepliesPositive),
  };
}
