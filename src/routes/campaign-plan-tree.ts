/**
 * A CAMPAIGN'S PLAN, FROM ITS TARGET DOWN, ENGINE BY ENGINE (owner 2026-11-24, PLAN-RECURSIVE-PER-ENGINE-1124; pure rule
 * `lib/campaign-plan-tree.ts`):
 *
 *   GET /brands/:brandId/sales-funnel-campaigns/:id/plan-tree   (org-scoped)
 *
 * Same auth, ownership check and inputs as its sibling `engine-scripts`: read live (every input is a stored build or
 * held 60 s), the draws seeded on the campaign and the Rating's build so one build reads the same on every read.
 * READ-ONLY on strategies: an Engine the campaign holds no stored verdict on reads `not_judged_yet` (every runnable
 * script but the opt-in ones compete, the runner's rule under no strategy); this read never asks the brief judge and
 * never writes a verdict; what the brief asks for (opt-in tactics) is the STORED answers too, never asked here. Never a value-per-dollar score. The board not built yet = 503 `script_rating_not_built_yet`.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import { loadFleetCell } from "../lib/fleet-cell-store.js";
import { SCRIPT_ENGINES_CELL } from "../lib/engine-favourites.js";
import { listEngineStrategies, labelOfOutcome } from "../lib/engine-strategy-io.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";
import { listBriefAsks } from "../lib/brief-opt-in-store.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { seededRng, CAMPAIGN_DRAWS } from "../lib/campaign-engine-scripts.js";
import { campaignPlanTree } from "../lib/campaign-plan-tree.js";
import { listDeclaredSteps } from "../lib/channel-declarations-store.js";
import { CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import { NEW_LEAD_STATE_STEPS } from "../lib/lead-states.js";
import { warmScriptEngines, type ScriptEnginesCell } from "./script-engines.js";

const router = Router();

router.get("/brands/:brandId/sales-funnel-campaigns/:id/plan-tree", apiKeyAuth, async (req, res) => {
  const auth = req as AuthenticatedRequest & { params: { brandId: string; id: string } };
  const { brandId, id } = auth.params;
  const headers = { orgId: auth.orgId, userId: auth.userId, runId: auth.runId, featureSlug: undefined };
  try {
    const [rows] = await Promise.all([fetchSalesFunnelCampaigns(brandId, null, headers), assertBrandHeld(brandId, headers)]);
    const row = rows.find((r) => r.id === id);
    if (!row) return void res.status(404).json({ error: "No sales funnel campaign with this id on this brand", reason: "sales_funnel_campaign_not_found" });
    const stored = await loadFleetCell(SCRIPT_ENGINES_CELL);
    const cell = stored ? (JSON.parse(stored.text) as ScriptEnginesCell) : null;
    if (!cell?.ratings || !cell.values) {
      void warmScriptEngines(true).catch((err) => console.error("[features-service] script engines board build failed:", err));
      return void res.status(503).json({ error: "The script Rating is being built (every 15 minutes).", reason: "script_rating_not_built_yet" });
    }
    const [strategies, briefAsks, runnable, catalogue, declared] = await Promise.all([listEngineStrategies(row.id), listBriefAsks(row.id), readRunnableScripts(), loadPlayCatalogue(), listDeclaredSteps()]);
    const labels = new Map<string, string>([
      ...Object.entries(CHANNEL_STEPS).map(([k, v]) => [k, v.label] as const),
      ...NEW_LEAD_STATE_STEPS.map((s) => [s.key, s.label] as const),
      ...declared.map((d) => [d.key, d.label] as const),
    ]);
    const labelOf = (o: string): string => labels.get(o) ?? labelOfOutcome(o);
    const tree = campaignPlanTree({
      target: row.target ?? null,
      stored: strategies,
      briefAsks,
      runnable,
      catalogue,
      fleetRatings: cell.ratings,
      values: new Map(cell.values.map((v) => [v.outcome, v])),
      labelOf,
      rngOf: (outcome) => seededRng(`${row.id}|${cell.computedAt}|${outcome}`),
    });
    res.json({
      salesFunnelCampaignId: row.id,
      brandId,
      target: row.target ? { key: row.target, label: labelOf(row.target) } : null,
      ratingComputedAt: cell.computedAt,
      draws: CAMPAIGN_DRAWS,
      strategiesReadFrom: "stored_verdicts",
      unavailableReason: tree.unavailableReason,
      nodes: tree.nodes,
    });
  } catch (error) {
    if (error instanceof BrandOwnershipError) return void res.status(404).json({ error: error.message, reason: "brand_not_found" });
    console.error(`[features-service] campaign plan tree ${id}:`, error);
    res.status(502).json({ error: (error as Error).message, reason: "campaign_plan_tree_unreadable" });
  }
});

export default router;
