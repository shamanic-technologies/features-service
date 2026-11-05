/**
 * THE SCRIPTS A CAMPAIGN'S STRATEGY KEEPS FOR ONE ENGINE (MIGRATE-1105 S0-STRATEGY; rule in `lib/script-strategy.ts`).
 *
 *   GET /internal/script-strategy?campaignId=&outcome=   (api key; workflow-service's Engine runner, per run)
 *
 * The campaign UNIT's own sales funnel names the strategy on the pipe it performs (the leg ladder's and writer pick's
 * rule, `playOfLegRead`); the Engine's runnable scripts come from workflow-service's catalogue (held 60 s), the verdicts
 * from the tactic sweep. Unreadable = 502: the runner runs nothing and retries (fail closed, never "any script").
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { fetchCampaignPipe } from "../lib/fleet-leg-campaigns.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";
import { scriptsKeptByStrategy } from "../lib/script-strategy.js";
import { playOfLegRead } from "./workflow-projection.js";

const router = Router();

router.get("/internal/script-strategy", apiKeyOnly, async (req: Request, res: Response) => {
  const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId.trim() : "";
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
  if (!campaignId || !outcome) return res.status(400).json({ error: "campaignId and outcome are required", reason: "campaign_and_outcome_required" });
  try {
    const unit = await fetchCampaignPipe(campaignId);
    if (!unit.found) return res.status(404).json({ error: `campaign-service lists no campaign ${campaignId}`, reason: "campaign_not_found" });
    const [catalogue, scripts, played] = await Promise.all([
      loadPlayCatalogue(),
      readRunnableScripts(),
      unit.featureSlug && unit.legKey ? playOfLegRead(unit.featureSlug, unit.legKey, unit.salesFunnelId) : Promise.resolve(null),
    ]);
    const strategy = played ? (catalogue.strategies.get(played.answer.strategyId) ?? null) : null;
    const playUnknown = played !== null && !strategy ? played.answer.strategyId || played.answer.id : null;
    const kept = scriptsKeptByStrategy(
      scripts.filter((s) => s.outcome === outcome),
      strategy,
      catalogue,
      playUnknown,
    );
    res.json({
      campaignId,
      outcome,
      strategyId: strategy?.id ?? null,
      strategyName: strategy?.name ?? null,
      strategySource: played?.answer.source ?? "no_strategy",
      ...kept,
    });
  } catch (error) {
    console.error(`[features-service] script strategy ${campaignId} x ${outcome} unreadable:`, error);
    res.status(502).json({ error: `the scripts this campaign's strategy keeps could not be read: ${(error as Error).message}`, reason: "script_strategy_unreadable" });
  }
});

export default router;
