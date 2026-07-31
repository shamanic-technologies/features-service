/**
 * GOAL ARBITRATION — which of the goals a brand AUTHORIZES returns the most per dollar, the best
 * workflow for that goal, and the per-audience evidence for that pairing, in ONE answer.
 *
 * WHY IT LIVES HERE. The normalization to terminal dollars (cost per paying client → return multiple)
 * is this service's job: it already owns the funnel economics, already ranks workflows on them, and
 * already exposes the per-audience evidence. The goal leg was the one lever in the chain nobody
 * arbitrated — campaign-service SUPPLIED it. Ranking it consumer-side would put an economics ranking in
 * a pacing service AND multiply requests per tick, for what is one pure pass over evidence this service
 * has already assembled (the `workflow-projection-evidence` fan-out is goal-INDEPENDENT, so N goals cost
 * N pure projections and ZERO extra IO).
 *
 * ── THE RANKING BASIS (the documented, stable, explainable rule) ──────────────────────────────────
 *
 *   returnPerDollar(goal) = lifetimeRevenueUsd / costPerPaidClientUsd(goal, best workflow)
 *
 * i.e. expected revenue per dollar of spend — the EXISTING `roiMultiple` (= 100 / cacPct). It is the
 * ONLY cross-goal-comparable number: a cost per outcome is denominated in the goal's OWN outcome (a
 * click, a reply, a booked meeting), so comparing two goals' cost-per-outcome compares two different
 * things. Normalising each goal through its OWN funnel to the same terminal unit — a paying client's
 * lifetime revenue — makes them commensurable. The winner is `argmax returnPerDollar`.
 *
 * Per goal, the BEST WORKFLOW is `argmin resolved.costPerOutcomeUsd` over the BRAND-LEVEL rows
 * (`audienceId === null`) — byte-for-byte the ungated argmin `fetchBrandProjectedParents` and the
 * Strategy page's `pickBestBrandRow` already use, so the arbitration can never crown a different
 * workflow than the two live surfaces for the same brand + goal. That argmin is EQUIVALENT to
 * `argmax returnPerDollar` within a goal: `costPerPaidClient = costPerOutcome / (outcome→paid rate)`
 * and that rate is a brand-level constant for the goal, so scaling every workflow by the same positive
 * factor cannot reorder them. Ranking on the cost keeps coherence with the existing surfaces; the
 * return then falls out of the winning row.
 *
 * ── A GOAL WITH NO DEFINED RETURN IS NEVER ELECTED ────────────────────────────────────────────────
 *
 * `whatsappConversation` has no path to a paying client at all (brand-service exposes no whatsapp→paid
 * rate), so its return is undefined — not zero, not "assume the click funnel". Such a goal is reported
 * as a candidate with `rankable: false` and its reason, and can never win. Same for a goal with no
 * economics, no workflow evidence, or a non-positive return. When NO authorized goal is rankable the
 * answer is `status: "unrankable"` with a reason — distinguishable from a winner, and never an error
 * that hides why.
 *
 * DETERMINISM (same evidence + same economics ⇒ same answer): candidates are emitted in the producer's
 * authorized order, and a tie on returnPerDollar is broken by the canonical `GOALS` index — never by
 * map iteration order.
 */

import {
  goalToProjectionInputs,
  projectFromEvidence,
  TARGET_OUTCOMES_PER_MONTH,
  type GoalEcho,
  type GrainName,
  type Objective,
  type ProjectionRow,
  type WorkflowProjectionEvidence,
  type WorkflowProjectionResponse,
} from "../routes/workflow-projection.js";
import type { AuthorizedGoalEntry } from "./authorized-goals.js";
import type { SalesEconomics } from "./funnel-registry.js";
import { GOALS, type Goal } from "./goals.js";

/** Why an authorized goal could not be ranked. Never a substituted value — the reason IS the answer. */
export type UnrankableReason =
  /** The brand has no effective economics for this goal (cold start) — nothing to normalise through. */
  | "no_economics"
  /** No workflow has a usable cost of this goal's outcome (no brand-level row with a positive cost). */
  | "no_workflow_evidence"
  /** The goal has no defined path to a paying client (whatsappConversation, or a rate chain at 0). */
  | "no_paid_client_path"
  /** A paid-client cost exists but the return is not a positive finite number (e.g. no lifetime revenue). */
  | "no_return_defined";

export interface ArbitrationWorkflow {
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
}

export interface GoalCandidate {
  goal: GoalEcho;
  objective: Objective;
  /** True ⟺ this goal has a defined, positive return per dollar and is therefore eligible to win. */
  rankable: boolean;
  unrankableReason: UnrankableReason | null;
  /** lifetimeRevenueUsd / costPerPaidClientUsd of the goal's best workflow. Null ⟺ not rankable. */
  returnPerDollar: number | null;
  costPerOutcomeUsd: number | null;
  costPerPaidClientUsd: number | null;
  /** Provenance label of the winning row's resolved pick (audience > brand > crossOrg benchmark). */
  grain: GrainName | null;
  workflow: ArbitrationWorkflow | null;
  /** True when this goal's economics were refined by the brand's PER-FUNNEL statement for it. */
  usesFunnelEconomics: boolean;
}

export type ArbitrationStatus = "resolved" | "unrankable";
export type ArbitrationReason = "no_authorized_goals" | "no_rankable_goal";

export interface GoalArbitrationResponse {
  featureSlug: string;
  /** The goals the brand authorizes, canonical camel, in the producer's order. Never caller-supplied. */
  authorizedGoals: GoalEcho[];
  arbitration: {
    status: ArbitrationStatus;
    goal: GoalEcho | null;
    objective: Objective | null;
    reason: ArbitrationReason | null;
    returnPerDollar: number | null;
    costPerOutcomeUsd: number | null;
    costPerPaidClientUsd: number | null;
    grain: GrainName | null;
  };
  workflow: ArbitrationWorkflow | null;
  economics: WorkflowProjectionResponse["economics"];
  candidates: GoalCandidate[];
  /**
   * The winning (goal × workflow) pairing's projection rows — the brand-level row plus EVERY active
   * audience's row for that dynasty, in the SAME `ProjectionRow` shape `/workflow-projection` serves,
   * so campaign-service's audience bandit consumes it with its existing parser (per-audience
   * `resolvedOutcomeCount` successes, `evidence.observedContacted` trials, `evidence.spentUsd` cost).
   * Empty when nothing could be ranked.
   */
  rows: ProjectionRow[];
  recommendedBudgetUsd: number | null;
}

const goalEchoOf = (goal: Goal): GoalEcho => goalToProjectionInputs(goal).goalEcho;

/** Per-funnel economics override merged OVER the brand's effective set (only stated fields win). */
function mergeEconomics(
  base: SalesEconomics | null,
  override: Partial<SalesEconomics> | null,
): SalesEconomics | null {
  if (!base) return null;
  if (!override) return base;
  return { ...base, ...override };
}

const isPositiveFinite = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

interface ScoredGoal {
  candidate: GoalCandidate;
  projection: WorkflowProjectionResponse;
  row: ProjectionRow | null;
}

/**
 * Score ONE authorized goal: project the shared evidence through that goal's funnel, take the brand's
 * best workflow for it, and read the goal's return per dollar off that row. Pure — no IO.
 *
 * Throws when the goal needs a conversion rate the brand's economics do not carry (the SAME fail-loud
 * behaviour `/workflow-projection` has for that goal today): a missing producer rate is a data gap to
 * surface, not an "unrankable" verdict to record.
 */
function scoreGoal(input: {
  featureSlug: string;
  entry: AuthorizedGoalEntry;
  evidence: WorkflowProjectionEvidence;
  economics: SalesEconomics | null;
}): ScoredGoal {
  const { featureSlug, entry, evidence } = input;
  const { objective, goalEcho, singleStepGoal, formSubmissionGoal } = goalToProjectionInputs(entry.goal);
  const economics = mergeEconomics(input.economics, entry.economics);
  const projection = projectFromEvidence({
    featureSlug,
    objective,
    goal: goalEcho,
    singleStepGoal,
    formSubmissionGoal,
    evidence,
    economics,
  });

  const base: Omit<GoalCandidate, "rankable" | "unrankableReason"> = {
    goal: goalEcho,
    objective,
    returnPerDollar: null,
    costPerOutcomeUsd: null,
    costPerPaidClientUsd: null,
    grain: null,
    workflow: null,
    usesFunnelEconomics: entry.economics != null,
  };
  const unrankable = (reason: UnrankableReason, extra: Partial<GoalCandidate> = {}): ScoredGoal => ({
    candidate: { ...base, ...extra, rankable: false, unrankableReason: reason },
    projection,
    row: null,
  });

  if (!economics) return unrankable("no_economics");

  // Best workflow = argmin cost-of-this-goal's-outcome over the BRAND-LEVEL rows — the same ungated
  // argmin the Strategy page and the audience-stats floor parent use, so all three agree.
  let best: ProjectionRow | null = null;
  for (const row of projection.rows) {
    if (row.audienceId !== null) continue;
    const cost = row.resolved.costPerOutcomeUsd;
    if (!isPositiveFinite(cost)) continue;
    const incumbent = best?.resolved.costPerOutcomeUsd ?? null;
    if (incumbent == null || cost < incumbent) best = row;
  }
  if (!best) return unrankable("no_workflow_evidence");

  const workflow: ArbitrationWorkflow = {
    workflowDynastySlug: best.workflow.workflowDynastySlug,
    workflowDynastyName: best.workflow.workflowDynastyName,
  };
  const withRow: Partial<GoalCandidate> = {
    costPerOutcomeUsd: best.resolved.costPerOutcomeUsd,
    costPerPaidClientUsd: best.resolved.costPerPaidClientUsd,
    grain: best.resolved.grain,
    workflow,
  };

  // No path to a paying client → no return to compare. `whatsappConversation` lands here structurally
  // (brand-service exposes no whatsapp→paid rate), as does any funnel whose rate chain collapses to 0.
  if (!isPositiveFinite(best.resolved.costPerPaidClientUsd)) return unrankable("no_paid_client_path", withRow);
  // roiMultiple = lifetimeRevenueUsd / costPerPaidClientUsd — non-positive/absent when the brand states
  // no lifetime revenue, so there is a paid-client cost but no return to rank on.
  if (!isPositiveFinite(best.resolved.roiMultiple)) return unrankable("no_return_defined", withRow);

  return {
    candidate: {
      ...base,
      ...withRow,
      returnPerDollar: best.resolved.roiMultiple,
      rankable: true,
      unrankableReason: null,
    },
    projection,
    row: best,
  };
}

/**
 * Arbitrate the brand's authorized goals against ONE already-assembled evidence set.
 *
 * `authorizedGoals` comes from brand-service (see authorized-goals.ts) — an EMPTY array is the real
 * "this brand authorizes nothing" answer and yields `status: "unrankable"`, reason
 * `"no_authorized_goals"`. An UNREADABLE set never reaches here: the route fails loud before calling.
 */
export function arbitrateGoals(input: {
  featureSlug: string;
  authorizedGoals: AuthorizedGoalEntry[];
  evidence: WorkflowProjectionEvidence;
  economics: SalesEconomics | null;
}): GoalArbitrationResponse {
  const { featureSlug, authorizedGoals, evidence, economics } = input;

  const scored = authorizedGoals.map((entry) => scoreGoal({ featureSlug, entry, evidence, economics }));
  const candidates = scored.map((s) => s.candidate);
  const authorizedEchoes = authorizedGoals.map((e) => goalEchoOf(e.goal));

  const empty = (reason: ArbitrationReason): GoalArbitrationResponse => ({
    featureSlug,
    authorizedGoals: authorizedEchoes,
    arbitration: {
      status: "unrankable",
      goal: null,
      objective: null,
      reason,
      returnPerDollar: null,
      costPerOutcomeUsd: null,
      costPerPaidClientUsd: null,
      grain: null,
    },
    workflow: null,
    // Echo the economics as the first scored goal saw them, so a consumer can still read the brand's
    // terms when nothing ranks. Null when there is no authorized goal at all (nothing was projected).
    economics: scored[0]?.projection.economics ?? null,
    candidates,
    rows: [],
    recommendedBudgetUsd: null,
  });

  if (authorizedGoals.length === 0) return empty("no_authorized_goals");

  // argmax returnPerDollar; ties broken by canonical GOALS order so the answer is stable.
  const goalIndex = (goal: Goal): number => GOALS.indexOf(goal);
  let winner: { scored: ScoredGoal; goal: Goal } | null = null;
  for (let i = 0; i < scored.length; i += 1) {
    const s = scored[i];
    if (!s.candidate.rankable) continue;
    const goal = authorizedGoals[i].goal;
    if (!winner) {
      winner = { scored: s, goal };
      continue;
    }
    const incumbent = winner.scored.candidate.returnPerDollar!;
    const challenger = s.candidate.returnPerDollar!;
    if (challenger > incumbent || (challenger === incumbent && goalIndex(goal) < goalIndex(winner.goal))) {
      winner = { scored: s, goal };
    }
  }

  if (!winner) return empty("no_rankable_goal");

  const { candidate, projection, row } = winner.scored;
  const dynasty = candidate.workflow!.workflowDynastySlug;
  // The winning PAIRING's rows: the brand-level row + every active audience's row for that dynasty.
  const rows = projection.rows.filter((r) => r.workflow.workflowDynastySlug === dynasty);

  return {
    featureSlug,
    authorizedGoals: authorizedEchoes,
    arbitration: {
      status: "resolved",
      goal: candidate.goal,
      objective: candidate.objective,
      reason: null,
      returnPerDollar: candidate.returnPerDollar,
      costPerOutcomeUsd: candidate.costPerOutcomeUsd,
      costPerPaidClientUsd: candidate.costPerPaidClientUsd,
      grain: candidate.grain,
    },
    workflow: candidate.workflow,
    economics: projection.economics,
    candidates,
    rows,
    recommendedBudgetUsd:
      row && isPositiveFinite(row.resolved.costPerOutcomeUsd)
        ? TARGET_OUTCOMES_PER_MONTH * row.resolved.costPerOutcomeUsd
        : null,
  };
}
