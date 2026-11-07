/**
 * SOCIAL-OUTCOMES-1107 (owner 2026-11-07: « nombre de posts publiés, engagements … Le $ ? Le yield ? Le ROI ? »). What one
 * published Unit is worth and what one costs, read off the catalogue model, so the Outcomes page of a published outcome
 * values it EXACTLY like a campaign whose Target it is (Today `measuredReturn`: Target outcomes x the Target's value ÷ spend,
 * value = the catalogue step value on the offer's lifetime revenue, `lib/factory-shadow.ts` `lineFigures`). PURE.
 *
 * One rule for every published outcome, no per-network branch:
 *   - the step = the outcome itself when the catalogue has a step of that key, else the step the pipes whose ENGINE makes
 *     the outcome land on (`CataloguePipe.outcome`, MIGRATE-1105 S5: `x_post_published` is made on the leg to Post published);
 *   - value per Unit = that step's `valueUsd` (LTR x the best rated route to Paid client);
 *   - expected cost per Unit = `expectedPipeCost` of the platform pipe making it, strongest basis first, then cheapest
 *     (the shadow plan's DECIDE rule input).
 */
import type { CatalogueModel, CataloguePipe } from "./agent-catalogue.js";

export interface OutcomeCatalogueFigures {
  step: string | null;
  valuePerUnitUsd: number | null;
  cost: { costPerUnitUsd: number; costSource: string; basis: string; pipeId: string } | null;
  unavailableReason: string | null;
}

const BASIS_RANK: Record<string, number> = { measured: 0, stated: 1, fleet: 2, default: 3 };

/** PURE. The catalogue pipes whose Engine makes `outcomeKey`, published. */
export function pipesMakingOutcome(model: Pick<CatalogueModel, "pipes">, outcomeKey: string): CataloguePipe[] {
  return [...model.pipes.values()].filter((p) => p.published && p.outcome === outcomeKey);
}

/** PURE. The step valued, its value per Unit, and the expected cost of one more Unit. */
export function outcomeCatalogueFigures(model: Pick<CatalogueModel, "pipes" | "steps">, outcomeKey: string): OutcomeCatalogueFigures {
  const pipes = pipesMakingOutcome(model, outcomeKey);
  const step = model.steps.has(outcomeKey) ? outcomeKey : (pipes[0]?.toStep ?? null);
  if (step === null) return { step: null, valuePerUnitUsd: null, cost: null, unavailableReason: "no_catalogue_step_for_outcome" };
  const valuePerUnitUsd = model.steps.get(step)?.valueUsd ?? null;
  const priced = pipes
    .filter((p) => p.operatedBy === "platform" && p.expectedCost && p.expectedCost.costPerOutcomeUsd > 0)
    .sort(
      (a, b) =>
        (BASIS_RANK[a.expectedCost!.basis] ?? 9) - (BASIS_RANK[b.expectedCost!.basis] ?? 9) ||
        a.expectedCost!.costPerOutcomeUsd - b.expectedCost!.costPerOutcomeUsd ||
        a.id.localeCompare(b.id),
    );
  const best = priced[0];
  return {
    step,
    valuePerUnitUsd,
    cost: best ? { costPerUnitUsd: best.expectedCost!.costPerOutcomeUsd, costSource: best.expectedCost!.source, basis: best.expectedCost!.basis, pipeId: best.id } : null,
    unavailableReason: valuePerUnitUsd === null ? "step_has_no_value" : null,
  };
}
