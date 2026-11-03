/**
 * ROI-CONSISTENCY-1103 (owner 2026-11-03, industrial cost accounting): a RETURN exists only where a value
 * lands. The revenue bodies (`/features/:slug/revenue` every grain, `/brands/:id/revenue`, `/brands/:id/offers`,
 * `/offers/:id/revenue`, the funnel campaign money) no longer SERVE the pipeline-based return: the
 * cost-economics ratios (`roiMultiple`, `costOfAcquisitionPct`, `costPerAcquisitionUsd`), their flash /
 * mature pair (`maturity`), the pipeline they divided (`ratioBasis.totalPipelineUsd`), and the pipeline
 * dollars themselves (`headline.totalPipelineUsd`, the dated `timeSeries`). The returns served are
 * `expectedReturn` and `costEconomics.realizedReturn` only.
 *
 * The engine still COMPUTES the pipeline in process: the expected return's measured rung, the deals /
 * lifecycle boards and the period recap read it. This module is the ONE place a body is cut down to its
 * served shape, applied at each route's compute (before the Gold cell persists), never inside the engine.
 * Route suites asserting the engine's in-process figures mock it to identity; `retired-returns.test.ts`
 * pins the cut and `return-fields-guard.test.ts` the served contract.
 */
import type { CostEconomics } from "./cost-economics.js";

export type ServedCostEconomics = Omit<
  CostEconomics,
  "roiMultiple" | "costOfAcquisitionPct" | "costPerAcquisitionUsd" | "maturity" | "ratioBasis"
> & { ratioBasis?: { committedCostUsd: number | null } };

/** PURE: the served cost-economics block: spend, maturity delay, realized return; no pipeline-based ratio. */
export function servedCostEconomics(ce: CostEconomics): ServedCostEconomics {
  const { roiMultiple: _r, costOfAcquisitionPct: _c, costPerAcquisitionUsd: _a, maturity: _m, ratioBasis, ...rest } = ce;
  return ratioBasis ? { ...rest, ratioBasis: { committedCostUsd: ratioBasis.committedCostUsd } } : rest;
}

type Headline = { totalPipelineUsd?: number | null } & Record<string, unknown>;

/** PURE: a headline without its pipeline dollars (its unpriced reason and lifetime revenue stay). */
export function servedHeadline<H extends Headline>(h: H): Omit<H, "totalPipelineUsd"> {
  const { totalPipelineUsd: _p, ...rest } = h;
  return rest;
}

type RevenueLike = {
  headline?: Headline | null;
  costEconomics?: CostEconomics | null;
  timeSeries?: unknown;
};

/**
 * PURE: one revenue body (or a lean group of one) in its served shape. Every other key is passed through
 * untouched, `expectedReturn` and `realizedReturn` included. Nested `channels[]` / `groups[]` / `offers[]`
 * rows are lean bodies too and are cut the same way.
 */
export function servedRevenueBody<T extends object>(body: T): T {
  const b = body as RevenueLike;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete out.timeSeries;
  if (b.headline) out.headline = servedHeadline(b.headline);
  if (b.costEconomics) out.costEconomics = servedCostEconomics(b.costEconomics);
  for (const key of ["channels", "groups", "offers"]) {
    const rows = out[key];
    if (Array.isArray(rows)) out[key] = rows.map((r) => (r && typeof r === "object" ? servedRevenueBody(r as object) : r));
  }
  return out as T;
}
