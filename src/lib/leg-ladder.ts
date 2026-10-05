/**
 * The leg-keyed `workflow-projection` ladder, run IN-PROCESS — the one price list per (channel, leg,
 * offer) every reader of "what does an outcome of this leg cost on this workflow" shares:
 * `/offers/:offerId/sales-paths` (the recommended workflow's price) and the contacted-lead value
 * (`routes/contacted-value.ts`, the price of the workflow that served each lead). Sharing the call is
 * what makes a campaign 100% on one workflow reproduce its sales path's ROI by construction.
 *
 * The route module is imported lazily: it sits above a large import graph that reaches back here.
 */
import type { Request, Response } from "express";

export interface LadderBody {
  recommendedWorkflowDynastySlug?: string | null;
  rows?: Array<{
    audienceId: string | null;
    workflow: { workflowDynastySlug: string };
    resolved: { grain: string | null; costPerOutcomeUsd: number | null };
  }>;
  reason?: string;
  unmeasuredReason?: string;
  recommendationWithheldReason?: string;
  recommendationBasis?: string;
}

/** Run the customer `workflow-projection` handler in-process and capture its answer. */
export async function runLadder(
  identity: { orgId: string; userId: string; runId: string },
  featureSlug: string,
  query: Record<string, string>,
): Promise<{ status: number; body: LadderBody }> {
  const { handleWorkflowProjection } = await import("../routes/workflow-projection.js");
  return new Promise((resolve, reject) => {
    const req = {
      params: { featureSlug },
      query,
      headers: {},
      orgId: identity.orgId,
      userId: identity.userId,
      runId: identity.runId,
      featureSlug,
    } as unknown as Request;
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return res;
      },
      json(body: LadderBody) {
        resolve({ status, body });
        return res;
      },
    } as unknown as Response;
    handleWorkflowProjection(req, res, "billed").catch(reject);
  });
}

/**
 * PURE: what one ladder says an outcome costs on ONE workflow dynasty — its brand row (`audienceId`
 * null), `resolved.costPerOutcomeUsd`. Never a neighbour's price: absent or null is a named reason.
 */
export function dynastyPriceFromLadder(
  status: number,
  body: LadderBody,
  workflowDynastySlug: string,
): { costPerOutcomeUsd: number | null; unpricedReason: string | null } {
  if (status !== 200) return { costPerOutcomeUsd: null, unpricedReason: body.reason ?? `ladder_${status}` };
  const row = (body.rows ?? []).find((r) => r.audienceId === null && r.workflow.workflowDynastySlug === workflowDynastySlug);
  if (!row) return { costPerOutcomeUsd: null, unpricedReason: "workflow_not_on_ladder" };
  const cost = row.resolved.costPerOutcomeUsd;
  return cost === null ? { costPerOutcomeUsd: null, unpricedReason: "workflow_unpriced" } : { costPerOutcomeUsd: cost, unpricedReason: null };
}
