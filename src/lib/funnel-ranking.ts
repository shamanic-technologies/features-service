/**
 * FUNNEL RANKING — which of the sales funnels a brand DECLARED returns the most per dollar, how every
 * other declared funnel compares, and the per-audience evidence for the best-returning pairing.
 *
 * ── IT IS A RECOMMENDATION, NOT A SELECTION ───────────────────────────────────────────────────────
 *
 * This used to BE the decision. campaign-service asked which goal to work and ran the one that came
 * back. That is over: the customer now funds each funnel separately (billing-service
 * brand_funnel_budgets) and campaign-service works EVERY funded funnel, pacing each against its own
 * ceiling and taking whichever has spent the least relative to what it may spend
 * (campaign-service#308). The money is what decides which funnel runs.
 *
 * So what this endpoint owes is a RANKING — advice a customer reads to decide where to put their
 * money, not an instruction a scheduler obeys. The value is the COMPARISON, not the winner: `ranking`
 * is the answer, and `recommendation` is simply its head. The legacy `arbitration` / `workflow` /
 * `rows` fields are kept byte-compatible because campaign-service still reads them in prod for a brand
 * with no per-funnel funding (its pre-funnel campaigns carry no goal of their own, so they still
 * inherit the top of this ranking). They are DERIVED from the same pick, so the two can never disagree.
 *
 * ── AN UNFUNDED FUNNEL IS STILL RANKED, AND THIS SERVICE NEVER ASKS BILLING ───────────────────────
 *
 * Ranking is about HISTORY: what a funnel has returned per dollar is what makes it comparable. Whether
 * it currently carries a daily ceiling is a decision the customer just made, not a reason to hide how
 * it performed — and a ranking that dropped the unfunded ones would answer "where should I move my
 * budget?" with only the places the budget already is. There is deliberately no billing read anywhere
 * in this path; funding is campaign-service's question at run time and it already asks it.
 *
 * ── THE RANKING BASIS (the documented, stable, explainable rule) ──────────────────────────────────
 *
 *   returnPerDollar(funnel) = lifetimeRevenueUsd / costPerPaidClientUsd(funnel, its best workflow)
 *
 * i.e. expected revenue per dollar of spend — the EXISTING `roiMultiple` (= 100 / cacPct). It is the
 * ONLY cross-funnel-comparable number: a cost per outcome is denominated in the funnel's OWN outcome (a
 * click, a reply, a booked meeting), so comparing two funnels' cost-per-outcome compares two different
 * things. Normalising each funnel through its OWN chain to the same terminal unit — a paying client's
 * lifetime revenue — makes them commensurable.
 *
 * Per funnel, the BEST WORKFLOW is `argmin resolved.costPerOutcomeUsd` over the BRAND-LEVEL rows
 * (`audienceId === null`) — byte-for-byte the ungated argmin `fetchBrandProjectedParents` and the
 * Strategy page's `pickBestBrandRow` already use, so the ranking can never crown a different workflow
 * than the two live surfaces for the same brand + goal. That argmin is EQUIVALENT to
 * `argmax returnPerDollar` within a funnel: `costPerPaidClient = costPerOutcome / (outcome→paid rate)`
 * and that rate is a constant for the funnel, so scaling every workflow by the same positive factor
 * cannot reorder them. Ranking on the cost keeps coherence with the existing surfaces; the return then
 * falls out of the winning row.
 *
 * ── A FUNNEL WITH NO DEFINED RETURN IS RANKED LAST, NEVER DROPPED ─────────────────────────────────
 *
 * A funnel whose chain collapses — the brand declared no rate on one of its legs, or no lifetime
 * revenue for a client won through it — has no defined return. Not zero, and never "borrow another
 * funnel's". It still appears in `ranking`, with `rankable: false`, its reason, and whatever IS known
 * about it (its own outcome cost and best workflow); it just carries no `rank`. Same for a funnel with
 * no economics and one with no workflow evidence. Hiding any of them would leave the customer comparing
 * against a list missing one of their own funnels.
 *
 * DETERMINISM (same evidence + same economics ⇒ same answer): rankable funnels sort on returnPerDollar
 * descending, ties broken by the canonical funnel-catalogue order (`salesFunnelIndex`); unrankable ones
 * follow in the producer's own order. Never by map iteration order.
 */

import {
  funnelToProjectionInputs,
  projectFromEvidence,
  TARGET_OUTCOMES_PER_MONTH,
  type GoalEcho,
  type GrainName,
  type Objective,
  type ProjectionRow,
  type WorkflowProjectionEvidence,
  type WorkflowProjectionResponse,
} from "../routes/workflow-projection.js";
import type { RankableFunnel } from "./declared-funnels.js";
import type { SalesEconomics } from "./funnel-registry.js";
import { salesFunnelIndex, type SalesFunnelKey } from "./sales-funnels.js";

/** Why a declared funnel could not be ranked. Never a substituted value — the reason IS the answer. */
export type UnrankableReason =
  /** The brand has no effective economics for this funnel (cold start) — nothing to normalise through. */
  | "no_economics"
  /** No workflow has a usable cost of this funnel's outcome (no brand-level row with a positive cost). */
  | "no_workflow_evidence"
  /** The funnel has no defined path to a paying client (a leg of its own chain sits at 0 / undeclared). */
  | "no_paid_client_path"
  /** A paid-client cost exists but the return is not a positive finite number (e.g. no lifetime revenue). */
  | "no_return_defined";

export interface RankedWorkflow {
  workflowDynastySlug: string;
  workflowDynastyName: string | null;
}

export interface RankedFunnel {
  /** brand-service's key for the funnel — the SAME key billing funds and campaign-service paces on, and
   * the ONLY field that identifies what was priced. The two meeting funnels differ here and nowhere
   * else in this shape: they carry the SAME `goal`/`objective` echo and DIFFERENT numbers. */
  funnelKey: SalesFunnelKey;
  /** The brand's own label for the funnel. */
  name: string;
  /** Legacy echo, DERIVED from `funnelKey`. campaign-service reads `arbitration.goal` in prod, so it
   * stays — but it is lossy by construction and must never be read as the identity of the row. */
  goal: GoalEcho;
  objective: Objective;
  /**
   * 1 for the best-returning funnel, 2 for the next, and so on. NULL when the funnel could not be
   * ranked — it is still listed, with its reason, so the comparison is never silently short.
   */
  rank: number | null;
  /** True ⟺ this funnel has a defined, positive return per dollar and therefore carries a `rank`. */
  rankable: boolean;
  unrankableReason: UnrankableReason | null;
  /** lifetimeRevenueUsd / costPerPaidClientUsd of the funnel's best workflow. Null ⟺ not rankable. */
  returnPerDollar: number | null;
  costPerOutcomeUsd: number | null;
  costPerPaidClientUsd: number | null;
  /** Provenance label of the best row's resolved pick (audience > brand > crossOrg benchmark). */
  grain: GrainName | null;
  workflow: RankedWorkflow | null;
  /** True when this funnel's own declared terms refined the brand's effective economics for it. */
  usesFunnelEconomics: boolean;
}

/** The head of the ranking, named as what it is: advice, not an instruction. */
export interface FunnelRecommendation {
  funnelKey: SalesFunnelKey;
  name: string;
  goal: GoalEcho;
  objective: Objective;
  returnPerDollar: number;
  costPerOutcomeUsd: number | null;
  costPerPaidClientUsd: number | null;
  grain: GrainName | null;
  workflow: RankedWorkflow;
}

export type ArbitrationStatus = "resolved" | "unrankable";
export type ArbitrationReason = "no_declared_funnels" | "no_rankable_funnel";

export interface GoalArbitrationResponse {
  featureSlug: string;
  /**
   * EVERY funnel the brand declared, funded or not, best return first and the unrankable ones after —
   * the answer this endpoint exists to give. A funnel's rank says how it has performed, never whether
   * it should run: what runs is decided by what the customer funds.
   */
  ranking: RankedFunnel[];
  /** The best-returning funnel. Null when nothing in `ranking` could be ranked. */
  recommendation: FunnelRecommendation | null;
  /**
   * COMPATIBILITY VIEW of `recommendation` for campaign-service, which reads `status`/`goal` in prod to
   * pace a brand that has no per-funnel funding. Derived from the same pick, so it can never name a
   * different funnel than the head of `ranking`.
   */
  arbitration: {
    status: ArbitrationStatus;
    /** The recommended funnel's key — the unambiguous half of this compatibility view. Added beside the
     * lossy `goal` so a consumer can migrate off it without a second endpoint. */
    funnelKey: SalesFunnelKey | null;
    goal: GoalEcho | null;
    objective: Objective | null;
    reason: ArbitrationReason | null;
    returnPerDollar: number | null;
    costPerOutcomeUsd: number | null;
    costPerPaidClientUsd: number | null;
    grain: GrainName | null;
  };
  workflow: RankedWorkflow | null;
  economics: WorkflowProjectionResponse["economics"];
  /**
   * The recommended (funnel × workflow) pairing's projection rows — the brand-level row plus EVERY
   * active audience's row for that dynasty, in the SAME `ProjectionRow` shape `/workflow-projection`
   * serves, so campaign-service's audience bandit consumes it with its existing parser (per-audience
   * `resolvedOutcomeCount` successes, `evidence.observedContacted` trials, `evidence.spentUsd` cost).
   * Empty when nothing could be ranked.
   */
  rows: ProjectionRow[];
  recommendedBudgetUsd: number | null;
}

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

interface ScoredFunnel {
  candidate: RankedFunnel;
  projection: WorkflowProjectionResponse;
  row: ProjectionRow | null;
}

/**
 * Score ONE declared funnel: project the shared evidence through that funnel's chain, take the brand's
 * best workflow for it, and read the funnel's return per dollar off that row. Pure — no IO.
 *
 * Throws when the funnel needs a conversion rate the brand's economics do not carry (the SAME fail-loud
 * behaviour `/workflow-projection` has for that goal today): a missing producer rate is a data gap to
 * surface, not an "unrankable" verdict to record.
 */
function scoreFunnel(input: {
  featureSlug: string;
  funnel: RankableFunnel;
  evidence: WorkflowProjectionEvidence;
  economics: SalesEconomics | null;
}): ScoredFunnel {
  const { featureSlug, funnel, evidence } = input;
  // Priced on the FUNNEL, not on a goal. `meetingChannel` is what makes the two meeting funnels
  // different numbers against the identical evidence: the conversation funnel is priced on
  // replyUsd / replyToMeetingPct, the website one on clickUsd / visitToMeetingPct.
  const { objective, goalEcho, singleStepGoal, formSubmissionGoal, meetingChannel } =
    funnelToProjectionInputs(funnel.funnelKey);
  const economics = mergeEconomics(input.economics, funnel.economics);
  const projection = projectFromEvidence({
    featureSlug,
    objective,
    goal: goalEcho,
    singleStepGoal,
    formSubmissionGoal,
    meetingChannel,
    funnelKey: funnel.funnelKey,
    evidence,
    economics,
  });

  const base: Omit<RankedFunnel, "rankable" | "unrankableReason"> = {
    funnelKey: funnel.funnelKey,
    name: funnel.name,
    goal: goalEcho,
    objective,
    rank: null,
    returnPerDollar: null,
    costPerOutcomeUsd: null,
    costPerPaidClientUsd: null,
    grain: null,
    workflow: null,
    usesFunnelEconomics: funnel.economics != null,
  };
  const unrankable = (reason: UnrankableReason, extra: Partial<RankedFunnel> = {}): ScoredFunnel => ({
    candidate: { ...base, ...extra, rankable: false, unrankableReason: reason },
    projection,
    row: null,
  });

  if (!economics) return unrankable("no_economics");

  // Best workflow = argmin cost-of-this-funnel's-outcome over the BRAND-LEVEL rows — the same ungated
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

  const workflow: RankedWorkflow = {
    workflowDynastySlug: best.workflow.workflowDynastySlug,
    workflowDynastyName: best.workflow.workflowDynastyName,
  };
  const withRow: Partial<RankedFunnel> = {
    costPerOutcomeUsd: best.resolved.costPerOutcomeUsd,
    costPerPaidClientUsd: best.resolved.costPerPaidClientUsd,
    grain: best.resolved.grain,
    workflow,
  };

  // No path to a paying client → no return to compare. Any chain with an undeclared or zero leg lands
  // here — including a meeting funnel whose OWN channel has no rate, which is exactly the case a
  // goal-keyed score used to hide behind the other channel's contribution.
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
 * Rank the brand's declared funnels against ONE already-assembled evidence set.
 *
 * `funnels` comes from brand-service (see declared-funnels.ts) — an EMPTY array means there is nothing
 * to rank and yields `arbitration.status: "unrankable"`, reason `"no_declared_funnels"`. An UNREADABLE
 * declaration never reaches here: the route fails loud before calling.
 */
export function rankDeclaredFunnels(input: {
  featureSlug: string;
  funnels: RankableFunnel[];
  evidence: WorkflowProjectionEvidence;
  economics: SalesEconomics | null;
}): GoalArbitrationResponse {
  const { featureSlug, funnels, evidence, economics } = input;

  const scored = funnels.map((funnel) => scoreFunnel({ featureSlug, funnel, evidence, economics }));

  // Rankable funnels first, best return per dollar down. Ties break on the canonical goal order and
  // then on funnelKey, so the same evidence always produces the same list. Unrankable funnels keep
  // brand-service's own order behind them — they are listed, never dropped.
  const rankableScored = scored
    .filter((s) => s.candidate.rankable)
    .sort((a, b) => {
      const byReturn = b.candidate.returnPerDollar! - a.candidate.returnPerDollar!;
      if (byReturn !== 0) return byReturn;
      return salesFunnelIndex(a.candidate.funnelKey) - salesFunnelIndex(b.candidate.funnelKey);
    });
  rankableScored.forEach((s, i) => {
    s.candidate.rank = i + 1;
  });
  const ranking = [...rankableScored, ...scored.filter((s) => !s.candidate.rankable)].map((s) => s.candidate);

  const top = rankableScored[0] ?? null;

  if (!top) {
    return {
      featureSlug,
      ranking,
      recommendation: null,
      arbitration: {
        status: "unrankable",
        funnelKey: null,
        goal: null,
        objective: null,
        reason: funnels.length === 0 ? "no_declared_funnels" : "no_rankable_funnel",
        returnPerDollar: null,
        costPerOutcomeUsd: null,
        costPerPaidClientUsd: null,
        grain: null,
      },
      workflow: null,
      // Echo the economics as the first scored funnel saw them, so a consumer can still read the
      // brand's terms when nothing ranks. Null when there was no funnel at all (nothing projected).
      economics: scored[0]?.projection.economics ?? null,
      rows: [],
      recommendedBudgetUsd: null,
    };
  }

  const { candidate, projection, row } = top;
  const workflow = candidate.workflow!;
  // The recommended PAIRING's rows: the brand-level row + every active audience's row for that dynasty.
  const rows = projection.rows.filter(
    (r) => r.workflow.workflowDynastySlug === workflow.workflowDynastySlug,
  );

  const recommendation: FunnelRecommendation = {
    funnelKey: candidate.funnelKey,
    name: candidate.name,
    goal: candidate.goal,
    objective: candidate.objective,
    returnPerDollar: candidate.returnPerDollar!,
    costPerOutcomeUsd: candidate.costPerOutcomeUsd,
    costPerPaidClientUsd: candidate.costPerPaidClientUsd,
    grain: candidate.grain,
    workflow,
  };

  return {
    featureSlug,
    ranking,
    recommendation,
    arbitration: {
      status: "resolved",
      funnelKey: recommendation.funnelKey,
      goal: recommendation.goal,
      objective: recommendation.objective,
      reason: null,
      returnPerDollar: recommendation.returnPerDollar,
      costPerOutcomeUsd: recommendation.costPerOutcomeUsd,
      costPerPaidClientUsd: recommendation.costPerPaidClientUsd,
      grain: recommendation.grain,
    },
    workflow,
    economics: projection.economics,
    rows,
    recommendedBudgetUsd:
      row && isPositiveFinite(row.resolved.costPerOutcomeUsd)
        ? TARGET_OUTCOMES_PER_MONTH * row.resolved.costPerOutcomeUsd
        : null,
  };
}
