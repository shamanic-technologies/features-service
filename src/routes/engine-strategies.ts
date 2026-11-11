/**
 * A CAMPAIGN'S STRATEGY PER ENGINE (MIGRATE-1105 S6; rules `lib/engine-strategy.ts`, IO `lib/engine-strategy-io.ts`).
 *
 *   GET  /internal/campaigns/:campaignId/engine-strategies   (api key) the verdicts one campaign holds, per Engine
 *   GET  /internal/engine-strategies                         (api key) every stored verdict (audit)
 *   POST /internal/engine-strategies/eval                    (api key, staff) the brief judge replayed, nothing stored
 *   (The S6 migration route `POST /internal/engine-strategies/carry` ran on 2026-11-08: 129 verdicts carried; deleted.)
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { engineStrategyOptions, engineStrategyState } from "../lib/engine-strategy.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";
import { askJev, labelOfOutcome, listEngineStrategies } from "../lib/engine-strategy-io.js";
import { fetchFleetCampaignRows } from "../lib/fleet-leg-campaigns.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";

const router = Router();

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

router.get("/internal/campaigns/:campaignId/engine-strategies", apiKeyOnly, async (req: Request, res: Response) => {
  try {
    res.json({ campaignId: req.params.campaignId, engines: await listEngineStrategies(String(req.params.campaignId)) });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message, reason: "engine_strategies_unreadable" });
  }
});

router.get("/internal/engine-strategies", apiKeyOnly, async (_req: Request, res: Response) => {
  try {
    res.json({ engines: await listEngineStrategies(null) });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message, reason: "engine_strategies_unreadable" });
  }
});

/**
 * POST /internal/engine-strategies/eval {campaignIds?: string[]} (api key, staff): the brief judge REPLAYED on every
 * stored verdict of the live campaigns (or the ones named), with today's options and question, NOTHING stored. Answers
 * per (campaign, Engine) the stored strategy beside what the judge picks now: the before/after of a change to what the
 * judge sees (a strategy description, the question).
 */
router.post("/internal/engine-strategies/eval", apiKeyOnly, async (req: Request, res: Response) => {
  try {
    const only = Array.isArray(req.body?.campaignIds) ? new Set((req.body.campaignIds as unknown[]).map(String)) : null;
    // A PROPOSED brief per campaign, judged instead of the stored one (nothing written): the replay of a brief rewrite.
    const proposed: Record<string, string> = req.body?.briefs && typeof req.body.briefs === "object" ? (req.body.briefs as Record<string, string>) : {};
    const units = (await fetchFleetCampaignRows()).map((r) => r as Record<string, unknown>).filter((u) => u.status === "ongoing" && str(u.salesFunnelCampaignId));
    const owner = new Map<string, { orgId: string; brandId: string }>();
    for (const u of units) {
      const brandId = Array.isArray(u.brandIds) ? str(u.brandIds[0]) : null;
      if (brandId && str(u.orgId)) owner.set(str(u.salesFunnelCampaignId)!, { orgId: str(u.orgId)!, brandId });
    }
    const stored = (await listEngineStrategies(null)).filter((r) => owner.has(r.campaignId) && (!only || only.has(r.campaignId)));
    const [catalogue, scripts] = await Promise.all([loadPlayCatalogue(), readRunnableScripts()]);
    const briefs = new Map<string, string | null>();
    const rows: Array<Record<string, unknown>> = [];
    for (const r of stored) {
      const o = owner.get(r.campaignId)!;
      if (!briefs.has(r.campaignId)) {
        const list = await fetchSalesFunnelCampaigns(o.brandId, null, { orgId: o.orgId });
        for (const c of list) briefs.set(c.id, c.brief ?? null);
      }
      const brief = typeof proposed[r.campaignId] === "string" ? proposed[r.campaignId]! : (briefs.get(r.campaignId) ?? null);
      const options = engineStrategyOptions(r.outcome, scripts, catalogue, r.strategyId ? [r.strategyId] : []);
      const base = { campaignId: r.campaignId, orgId: r.orgId, outcome: r.outcome, stored: r.strategyId, storedSource: r.source };
      if (!brief?.trim()) {
        rows.push({ ...base, picked: options[0]?.strategyId ?? null, confidence: null, note: "no brief: no condition (every runnable script)" });
        continue;
      }
      if (options.length <= 1) {
        rows.push({ ...base, picked: options[0]?.strategyId ?? null, confidence: null, note: "single option" });
        continue;
      }
      try {
        const pick = await askJev(engineStrategyState(brief, { outcome: r.outcome, label: labelOfOutcome(r.outcome) }, { scripts, options, c: catalogue }), options);
        rows.push({ ...base, picked: pick.option.strategyId, confidence: pick.confidence, note: null });
      } catch (error) {
        rows.push({ ...base, picked: null, confidence: null, note: `judge failed: ${(error as Error).message}` });
      }
    }
    const differ = rows.filter((x) => x.picked !== x.stored).length;
    console.log(`[features-service] engine strategy eval: ${rows.length} verdict(s) replayed, ${differ} differ from the stored one`);
    res.json({ count: rows.length, differ, rows });
  } catch (error) {
    console.error("[features-service] engine strategy eval failed:", error);
    res.status(502).json({ error: (error as Error).message, reason: "engine_strategy_eval_failed" });
  }
});

export default router;
