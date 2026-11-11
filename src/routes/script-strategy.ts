/**
 * THE SCRIPTS A CAMPAIGN'S STRATEGY KEEPS FOR ONE ENGINE (MIGRATE-1105 S0-STRATEGY; rule in `lib/script-strategy.ts`).
 *
 *   GET /internal/script-strategy?campaignId=&outcome=   (api key; workflow-service's Engine runner, per run)
 *
 * MIGRATE-1105 S6 (owner 2026-11-07): the strategy the campaign keeps on this Engine (`lib/engine-strategy-io.ts`, stored
 * per campaign x Engine, judged from its brief). The Engine's runnable scripts come from workflow-service's catalogue
 * (held 60 s), the verdicts from the tactic sweep. Unreadable = 502: the runner runs nothing and retries. No brief = no
 * condition (`strategyId: null`, every runnable script; NO-BRIEF-UNBLOCK-1111, was 503 `campaign_states_no_brief`).
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { fetchCampaignPipe } from "../lib/fleet-leg-campaigns.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";
import { scriptsKeptByStrategy } from "../lib/script-strategy.js";
import { engineStrategyOfCampaign } from "../lib/engine-strategy-io.js";
import { noteEngineAnswer } from "../lib/engine-held-monitor.js";

const router = Router();

router.get("/internal/script-strategy", apiKeyOnly, async (req: Request, res: Response) => {
  const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId.trim() : "";
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
  if (!campaignId || !outcome) return res.status(400).json({ error: "campaignId and outcome are required", reason: "campaign_and_outcome_required" });
  try {
    const unit = await fetchCampaignPipe(campaignId);
    if (!unit.found) return res.status(404).json({ error: `campaign-service lists no campaign ${campaignId}`, reason: "campaign_not_found" });
    // MIGRATE-1105 S6: the strategy the campaign keeps on THIS Engine, stored on the campaign (judged from its brief). No
    // pipe, leg, play, sales funnel id or default play: a row naming no campaign runs nothing.
    if (!unit.salesFunnelCampaignId || !unit.orgId || !unit.brandId) {
      noteEngineAnswer(campaignId, outcome, "campaign_states_no_campaign");
      return res.status(422).json({ error: `campaign ${campaignId} belongs to no campaign a person runs: no strategy, nothing runs`, reason: "campaign_states_no_campaign" });
    }
    const stored = await engineStrategyOfCampaign({ campaignId: unit.salesFunnelCampaignId, orgId: unit.orgId, brandId: unit.brandId }, { outcome });
    if (stored.kind !== "kept") throw new Error(`no verdict for campaign ${unit.salesFunnelCampaignId} on ${outcome}`);
    const [catalogue, scripts] = await Promise.all([loadPlayCatalogue(), readRunnableScripts()]);
    const kept = scriptsKeptByStrategy(scripts.filter((s) => s.outcome === outcome), stored.strategy, catalogue);
    // An Engine whose strategy keeps no runnable script cannot run either: red on Monitoring (NO-BRIEF-UNBLOCK-1111).
    noteEngineAnswer(campaignId, outcome, kept.keptDynasties.length === 0 ? "no_runnable_script_kept" : null);
    res.json({
      campaignId,
      outcome,
      strategyId: stored.strategy?.id ?? null,
      strategyName: stored.strategy?.name ?? null,
      strategySource: `campaign_engine_${stored.row.source}`,
      ...kept,
    });
  } catch (error) {
    console.error(`[features-service] script strategy ${campaignId} x ${outcome} unreadable:`, error);
    noteEngineAnswer(campaignId, outcome, "script_strategy_unreadable");
    res.status(502).json({ error: `the scripts this campaign's strategy keeps could not be read: ${(error as Error).message}`, reason: "script_strategy_unreadable" });
  }
});

export default router;
