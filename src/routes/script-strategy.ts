/**
 * THE SCRIPTS A CAMPAIGN'S STRATEGY KEEPS FOR ONE ENGINE (MIGRATE-1105 S0-STRATEGY; rule in `lib/script-strategy.ts`).
 *
 *   GET /internal/script-strategy?campaignId=&outcome=   (api key; workflow-service's Engine runner, per run)
 *
 * MIGRATE-1105 S6 (owner 2026-11-07): the strategy the campaign keeps on this Engine (`lib/engine-strategy-io.ts`, stored
 * per campaign x Engine, judged from its brief). The Engine's runnable scripts come from workflow-service's catalogue
 * (held 60 s), the verdicts from the tactic sweep. Unreadable = 502: the runner runs nothing and retries. No brief = no
 * condition (`strategyId: null`, every runnable script; NO-BRIEF-UNBLOCK-1111, was 503 `campaign_states_no_brief`).
 *
 *   GET /internal/script-strategy?outcome=[&strategyId=]   (api key; no campaign yet, PREVIEW-EMAIL-503-1111)
 *
 * The same rule for a read made BEFORE any campaign exists (content-generation's preview email of a brand-new brand): the
 * strategy is the one the caller names (`strategyId`, read from the catalogue, unknown = 404 `strategy_not_found`), none =
 * no condition = every runnable script of the Engine. Never a default strategy, never a workflow, pipe or play ranking: a
 * brand with zero history gets the Engine's runnable scripts, and workflow-service's Rating picks among them.
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
  if (!outcome) return res.status(400).json({ error: "outcome is required", reason: "campaign_and_outcome_required" });
  if (!campaignId) return scriptsWithoutCampaign(req, res, outcome);
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

/** PREVIEW-EMAIL-503-1111: no campaign yet. The strategy the caller names, else no condition (every runnable script). */
async function scriptsWithoutCampaign(req: Request, res: Response, outcome: string) {
  const strategyId = typeof req.query.strategyId === "string" && req.query.strategyId.trim() ? req.query.strategyId.trim() : null;
  try {
    const [catalogue, scripts] = await Promise.all([loadPlayCatalogue(), readRunnableScripts()]);
    const strategy = strategyId ? (catalogue.strategies.get(strategyId) ?? null) : null;
    if (strategyId && !strategy) return res.status(404).json({ error: `no strategy ${strategyId} in the catalogue`, reason: "strategy_not_found" });
    const kept = scriptsKeptByStrategy(scripts.filter((s) => s.outcome === outcome), strategy, catalogue);
    res.json({
      campaignId: null,
      outcome,
      strategyId: strategy?.id ?? null,
      strategyName: strategy?.name ?? null,
      strategySource: strategy ? "stated_by_caller" : "no_campaign",
      ...kept,
    });
  } catch (error) {
    console.error(`[features-service] script strategy (no campaign) ${outcome} x ${strategyId ?? "no strategy"} unreadable:`, error);
    res.status(502).json({ error: `the scripts this strategy keeps could not be read: ${(error as Error).message}`, reason: "script_strategy_unreadable" });
  }
}

/**
 * NEXT-STEPS-TRUE-REASON-1111: a service that holds a campaign Engine's run for a reason of its OWN (a budget spent, an
 * Engine state it cannot read...) states it here, so the campaign's next-steps read and Monitoring name it like a
 * refusal of this service. `heldReason: null` = the Engine ran (clears it). Same store, same window (1 h), any reason.
 */
router.post("/internal/campaign-engine-answers", apiKeyOnly, (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const campaignId = typeof b.campaignId === "string" ? b.campaignId.trim() : "";
  const outcome = typeof b.outcome === "string" ? b.outcome.trim() : "";
  const heldReason = b.heldReason === null ? null : typeof b.heldReason === "string" && b.heldReason.trim() ? b.heldReason.trim() : undefined;
  // MON-HELD-FALSE-1113: `expected: true` = a hold made on purpose (out of credit, ceiling reached): never red on Monitoring.
  const expected = b.expected === undefined ? false : typeof b.expected === "boolean" ? b.expected : undefined;
  if (!campaignId || !outcome || heldReason === undefined || expected === undefined) {
    return res.status(400).json({ error: "campaignId, outcome and heldReason (a reason, or null when the Engine ran) are required; expected, when sent, is a boolean", reason: "engine_answer_unrecognised" });
  }
  noteEngineAnswer(campaignId, outcome, heldReason, Date.now(), expected);
  res.status(202).json({ campaignId, outcome, heldReason, expected: heldReason !== null && expected });
});

export default router;
