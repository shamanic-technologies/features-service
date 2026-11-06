/**
 * THE SCRIPTS A CAMPAIGN'S STRATEGY KEEPS FOR ONE ENGINE (MIGRATE-1105 S0-STRATEGY; rule in `lib/script-strategy.ts`).
 *
 *   GET /internal/script-strategy?campaignId=&outcome=   (api key; workflow-service's Engine runner, per run)
 *
 * The campaign's BRIEF decides the strategy (MIGRATE-1105 S0b, owner 2026-11-06: a brief rewritten to « Contacted pure
 * prospects » ran the funnel's catch-all find script): the brief judge's play for the unit's pipe (`briefPlayOfUnit`, Jev
 * asked when the brief moved) wins; a brief that picks nothing on the pipe leaves the unit's own sales funnel naming it
 * (the leg ladder's and writer pick's rule, `playOfLegRead`). The Engine's runnable scripts come from workflow-service's catalogue (held 60 s), the verdicts
 * from the tactic sweep. Unreadable = 502: the runner runs nothing and retries (fail closed, never "any script").
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { fetchCampaignPipe } from "../lib/fleet-leg-campaigns.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";
import { scriptsKeptByStrategy } from "../lib/script-strategy.js";
import { playOfLegRead } from "./workflow-projection.js";
import { briefPlayOfUnit } from "./factory-shadow.js";

const router = Router();

router.get("/internal/script-strategy", apiKeyOnly, async (req: Request, res: Response) => {
  const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId.trim() : "";
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
  if (!campaignId || !outcome) return res.status(400).json({ error: "campaignId and outcome are required", reason: "campaign_and_outcome_required" });
  try {
    const unit = await fetchCampaignPipe(campaignId);
    if (!unit.found) return res.status(404).json({ error: `campaign-service lists no campaign ${campaignId}`, reason: "campaign_not_found" });
    const pipe = unit.featureSlug && unit.legKey ? { featureSlug: unit.featureSlug, legKey: unit.legKey } : null;
    const [catalogue, scripts, played, briefed] = await Promise.all([
      loadPlayCatalogue(),
      readRunnableScripts(),
      pipe ? playOfLegRead(pipe.featureSlug, pipe.legKey, unit.salesFunnelId) : Promise.resolve(null),
      pipe && unit.salesFunnelCampaignId && unit.orgId && unit.brandId
        ? briefPlayOfUnit({ salesFunnelCampaignId: unit.salesFunnelCampaignId, orgId: unit.orgId, brandId: unit.brandId, ...pipe })
        : Promise.resolve(null),
    ]);
    const briefStrategy = briefed ? (catalogue.strategies.get(briefed.strategyId) ?? null) : null;
    const strategy = briefStrategy ?? (played ? (catalogue.strategies.get(played.answer.strategyId) ?? null) : null);
    const playUnknown = !briefStrategy && played !== null && !strategy ? played.answer.strategyId || played.answer.id : null;
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
      strategySource: briefStrategy ? "brief" : (played?.answer.source ?? "no_strategy"),
      briefPlayId: briefed?.playId ?? null,
      ...kept,
    });
  } catch (error) {
    console.error(`[features-service] script strategy ${campaignId} x ${outcome} unreadable:`, error);
    res.status(502).json({ error: `the scripts this campaign's strategy keeps could not be read: ${(error as Error).message}`, reason: "script_strategy_unreadable" });
  }
});

export default router;
