/**
 * A CAMPAIGN'S OWN VIEW OF ITS ENGINES, IN SCRIPTS (owner 2026-11-13, CAMPAIGN-SCRIPTS-1113; pure rule
 * `lib/campaign-engine-scripts.ts`). The client's campaign page:
 *
 *   GET /brands/:brandId/sales-funnel-campaigns/:id/engine-scripts   (org-scoped)
 *
 * From its Target down, at each Engine it uses: the scripts its brief's strategy keeps and what it rules out (in words),
 * today's share of draws among the kept ones (the Rating the Monitoring board stored, drawn for THIS campaign's
 * candidates), this campaign's own runs of each (runs-service script decisions of its unit campaigns), and the script
 * the draws pick most now. Read live (every input is a stored build or held 60 s); never a value-per-dollar score.
 * The board not built yet = 503 `script_rating_not_built_yet`.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import { loadFleetCell } from "../lib/fleet-cell-store.js";
import { SCRIPT_ENGINES_CELL } from "../lib/engine-favourites.js";
import { listEngineStrategies, labelOfOutcome } from "../lib/engine-strategy-io.js";
import { readRunnableScripts, scriptDynastyKey } from "../lib/script-catalogue-client.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { readCampaignScriptReach } from "../lib/script-value-rating-io.js";
import { rehomeGroups } from "../lib/script-value-rating.js";
import { campaignEngineScripts, seededRng, CAMPAIGN_DRAWS } from "../lib/campaign-engine-scripts.js";
import { listDeclaredSteps } from "../lib/channel-declarations-store.js";
import { CHANNEL_STEPS } from "../lib/acquisition-channels.js";
import { NEW_LEAD_STATE_STEPS } from "../lib/lead-states.js";
import { warmScriptEngines, type ScriptEnginesCell } from "./script-engines.js";

const router = Router();

router.get("/brands/:brandId/sales-funnel-campaigns/:id/engine-scripts", apiKeyAuth, async (req, res) => {
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
    const unitIds = row.units.map((u) => u.campaignId);
    const [strategies, runnable, catalogue, reach, declared] = await Promise.all([
      listEngineStrategies(row.id),
      readRunnableScripts(),
      loadPlayCatalogue(),
      readCampaignScriptReach(unitIds),
      listDeclaredSteps(),
    ]);
    const labels = new Map<string, string>([
      ...Object.entries(CHANNEL_STEPS).map(([k, v]) => [k, v.label] as const),
      ...NEW_LEAD_STATE_STEPS.map((s) => [s.key, s.label] as const),
      ...declared.map((d) => [d.key, d.label] as const),
    ]);
    const labelOf = (o: string): string => labels.get(o) ?? labelOfOutcome(o);
    const engines = campaignEngineScripts({
      target: row.target ?? null,
      stored: strategies,
      runnable,
      catalogue,
      fleetRatings: cell.ratings,
      values: new Map(cell.values.map((v) => [v.outcome, v])),
      campaignGroups: rehomeGroups(reach.groups, runnable.map(scriptDynastyKey)),
      labelOf,
      rng: seededRng(`${row.id}|${cell.computedAt}`),
    });
    res.json({
      salesFunnelCampaignId: row.id,
      brandId,
      target: row.target ? { key: row.target, label: labelOf(row.target) } : null,
      ratingComputedAt: cell.computedAt,
      runsBuiltAt: reach.groups.length ? reach.builtAt : null,
      draws: CAMPAIGN_DRAWS,
      engines,
    });
  } catch (error) {
    if (error instanceof BrandOwnershipError) return void res.status(404).json({ error: error.message, reason: "brand_not_found" });
    console.error(`[features-service] campaign engine scripts ${id}:`, error);
    res.status(502).json({ error: (error as Error).message, reason: "campaign_engine_scripts_unreadable" });
  }
});

export default router;
