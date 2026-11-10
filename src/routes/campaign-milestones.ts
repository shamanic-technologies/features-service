/**
 * FACTORY-USER-DASHBOARD-1102: `GET /brands/:brandId/sales-funnel-campaigns/:id/milestones` (customer campaign page,
 * GTM Factory "Milestones"). Composes three reads the campaign already has, nothing recomputed: its people per step
 * (the activity Gold cell), each pipe's own spend and outcomes (the spend charts Gold cell) and its stored plan line
 * (the factory pass, expected figures). Pure rule in `lib/campaign-milestones.ts`.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import type { DownstreamHeaders } from "./revenue.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { parsePricing } from "../lib/pricing.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import { funnelCampaignActivity } from "./sales-funnel-campaign-activity.js";
import { funnelCampaignSpendCharts } from "./spend-charts.js";
import { funnelCopiesFor } from "./agent-catalogue.js";
import { readPlan } from "../lib/factory-shadow-store.js";
import { milestonesOf, type MilestoneLegFigures } from "../lib/campaign-milestones.js";
import { peopleJourneysOf } from "../lib/people-journeys.js";
import { withJourneyScriptMarks } from "../lib/catalogue-mark-serving.js";
import { fetchRunsCostCentsByWorkflowSlug } from "../lib/runs-cost-client.js";
import { fetchPublicWorkflows } from "../lib/public-stats-clients.js";
import { dynastyOfSlug } from "../lib/workflow-scope.js";

const router = Router();

interface StoredRunningLine {
  plan?: {
    target?: string;
    running?: {
      legs?: Array<{ legKey: string; pipeId: string }>;
      figures?: { legs?: Array<{ legKey: string; pipeId: string; costPerOutcomeUsd: number | null; ratePct: number | null; outcomesNeededPerPayingClient: number | null; costSource: string | null }> } | null;
    } | null;
  } | null;
}

router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/milestones", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });

    // Rows = the campaign's OWN funnel up to its Target (stable for its life); the stored plan line only lends expected
    // figures by step (OUTCOME-RUNG-AND-TARGET-1106: rows built on the plan line moved and dropped past outcomes per tick).
    const [stored, activity, charts] = await Promise.all([
      readPlan(row.id),
      funnelCampaignActivity(row, brandId, headers, pricing),
      funnelCampaignSpendCharts(row, brandId, pricing, headers),
    ]);
    const plan = stored && stored.orgId === auth.orgId ? (stored.body as StoredRunningLine).plan ?? null : null;
    const line = plan?.running ?? null;
    const target = row.target ?? plan?.target ?? null;
    const base = { salesFunnelCampaignId: row.id, brandId, pricing, target, planComputedAt: plan ? stored!.computedAt : null };
    if (!activity.funnel) return void res.json({ ...base, milestones: [], milestonesUnavailableReason: activity.funnelUnavailableReason ?? "funnel_not_counted" });
    const planLegs: MilestoneLegFigures[] = [];
    if (line?.legs && line.legs.length > 0) {
      const { pipeSteps } = await funnelCopiesFor([row.salesFunnelId]);
      const stepsOfPipe = (pipeId: string) => pipeSteps.get(pipeId) ?? pipeSteps.get(pipeId.split("~")[0]!) ?? null;
      const figures = new Map((line.figures?.legs ?? []).map((l) => [l.legKey, l]));
      for (const l of line.legs) {
        const steps = stepsOfPipe(l.pipeId);
        if (!steps) return void res.status(502).json({ error: `pipe ${l.pipeId} of the plan line is not in the catalogue`, reason: "plan_pipe_unknown" });
        const f = figures.get(l.legKey);
        planLegs.push({ legKey: l.legKey, toStep: steps.toStep, costPerOutcomeUsd: f?.costPerOutcomeUsd ?? null, ratePct: f?.ratePct ?? null, outcomesNeededPerPayingClient: f?.outcomesNeededPerPayingClient ?? null, costSource: f?.costSource ?? null });
      }
    }
    const steps = activity.funnel.steps.filter((s) => s.kind === "step").map((s) => ({ key: s.key, label: s.label, people: s.people }));
    const pipes = charts.pipes.flatMap((p) => (p.leg ? [{ toStep: p.leg.toStep, spendUsd: p.totals.spendUsd, outcomes: p.totals.outcomes }] : []));
    res.json({
      ...base,
      milestones: milestonesOf({ steps, target, planLegs, planUnavailableReason: planLegs.length > 0 ? null : "plan_not_computed_yet", pipes }),
      milestonesUnavailableReason: null,
    });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign milestones error:", err);
    res.status(502).json({ error: "Failed to read the campaign's milestones" });
  }
});

/**
 * `GET /brands/:brandId/sales-funnel-campaigns/:id/people-journeys` (GTM Factory "What its people went through"):
 * per transition of the campaign's pipes (path order), how many of its people made it (the campaign page's own count, as
 * the milestones read) and
 * each workflow's share of that pipe's committed spend (`lib/people-journeys.ts`). Org-scoped.
 */
router.get("/brands/:brandId/sales-funnel-campaigns/:salesFunnelCampaignId/people-journeys", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; salesFunnelCampaignId: string } };
    const { brandId, salesFunnelCampaignId } = auth.params;
    const pricing = parsePricing(req.query.pricing);
    if (pricing === null) return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const headers: DownstreamHeaders = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === salesFunnelCampaignId);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });

    const [activity, charts, { pathOf }] = await Promise.all([
      funnelCampaignActivity(row, brandId, headers, pricing),
      funnelCampaignSpendCharts(row, brandId, pricing, headers),
      funnelCopiesFor([row.salesFunnelId]),
    ]);
    const runByUs = new Map((pathOf(row.salesFunnelId)?.items ?? []).flatMap((i) => (i.kind === "channel" ? [[i.pipeId, i.runByUs] as const] : [])));
    const runByUsOf = (pipeId: string) => runByUs.get(pipeId) ?? runByUs.get(pipeId.split("~")[0]!) ?? true;
    // BACKLINK-ENGINE-1109: a unit an Engine runs with no pipe states no feature slug.
    const slugs = [...new Set(row.units.flatMap((u) => (u.featureSlug === null ? [] : [u.featureSlug])))];
    const [workflows, spends] = await Promise.all([
      slugs.length === 0 ? Promise.resolve([] as Awaited<ReturnType<typeof fetchPublicWorkflows>>) : fetchPublicWorkflows(slugs.join(",")),
      Promise.all(charts.pipes.map((p) => fetchRunsCostCentsByWorkflowSlug(brandId, p.featureSlug, headers, pricing, p.campaignId))),
    ]);
    const dynastyOf = dynastyOfSlug(workflows);
    const names = new Map(workflows.map((w) => [w.workflowDynastySlug, w.workflowDynastyName] as const));
    const labels = new Map((activity.funnel?.steps ?? []).map((s) => [s.key, s.label] as const));
    const peopleOf = new Map((activity.funnel?.steps ?? []).flatMap((s) => (s.kind === "step" && s.people !== null ? [[s.key, s.people] as const] : [])));
    const titleOf = (key: string) => key.split("_").map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
    const transitions = peopleJourneysOf(
      charts.pipes.flatMap((p, i) => {
        if (!p.leg) return [];
        const byDynasty = new Map<string, number>();
        for (const [slug, c] of spends[i]!) byDynasty.set(dynastyOf(slug), (byDynasty.get(dynastyOf(slug)) ?? 0) + c.committedCents);
        // The campaign page's own count of who reached the step (the milestones' too), the chart's when the page has none.
        const people = peopleOf.get(p.leg.toStep) ?? p.totals.outcomes ?? null;
        return [{ pipeId: p.pipeId, fromStep: p.leg.fromStep, toStep: p.leg.toStep, people, runByUs: runByUsOf(p.pipeId), spendByDynasty: byDynasty }];
      }),
      (k) => labels.get(k) ?? titleOf(k),
      (d) => names.get(d) ?? titleOf(d.replace(/-/g, "_")),
    );
    res.json({ salesFunnelCampaignId: row.id, brandId, pricing, transitions: await withJourneyScriptMarks(transitions) });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] campaign people journeys error:", err);
    res.status(502).json({ error: "Failed to read what the campaign's people went through" });
  }
});

export default router;
