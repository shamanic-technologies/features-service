/**
 * A CAMPAIGN'S STRATEGY PER ENGINE (MIGRATE-1105 S6; rules `lib/engine-strategy.ts`, IO `lib/engine-strategy-io.ts`).
 *
 *   GET  /internal/campaigns/:campaignId/engine-strategies   (api key) the verdicts one campaign holds, per Engine
 *   GET  /internal/engine-strategies                         (api key) every stored verdict (audit)
 *   POST /internal/engine-strategies/carry  {apply?: boolean} (api key, staff) THE S6 MIGRATION: every live campaign unit
 *        an Engine or a workflow runs gets its campaign's verdict on that Engine, carried from what it runs today (the
 *        brief judge's play, else its sales funnel's play, else its pipe's default play: the script-strategy read's own
 *        rule). A campaign that already holds a verdict on the Engine is never touched. `apply: false` = dry run.
 *        A campaign with two units on one Engine naming two strategies is refused (listed, nothing written for it).
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { briefHashOf } from "../lib/engine-strategy.js";
import { engineOutcomeOfPipe, listEngineStrategies, readEngineStrategy, writeEngineStrategy } from "../lib/engine-strategy-io.js";
import { fetchCampaignPipe, fetchFleetCampaignRows } from "../lib/fleet-leg-campaigns.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import { playOfLegRead } from "./workflow-projection.js";
import { briefPlayOfUnit } from "./factory-shadow.js";

const router = Router();

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

interface CarryRow {
  campaignId: string;
  unitId: string;
  orgId: string;
  featureSlug: string;
  legKey: string;
  outcome: string | null;
  strategyId: string | null;
  carriedFrom: string | null;
  /** `written` / `would_write` / `held` (a verdict stands) / `conflict` / `no_engine` / `unknown_play` / `failed`. */
  result: string;
  detail: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

router.post("/internal/engine-strategies/carry", apiKeyOnly, async (req: Request, res: Response) => {
  const apply = req.body?.apply === true;
  try {
    const units = (await fetchFleetCampaignRows())
      .map((raw) => raw as Record<string, unknown>)
      .filter((u) => u.status === "ongoing" && str(u.salesFunnelCampaignId) && str(u.workflowSlug) && str(u.featureSlug) && str(u.legKey) && str(u.orgId));
    const rows: CarryRow[] = [];
    const briefs = new Map<string, Promise<Map<string, string | null>>>();
    const briefOf = async (orgId: string, brandId: string, campaignId: string) => {
      const k = `${orgId}|${brandId}`;
      if (!briefs.has(k)) briefs.set(k, fetchSalesFunnelCampaigns(brandId, null, { orgId }).then((rs) => new Map(rs.map((r) => [r.id, r.brief ?? null]))));
      const m = await briefs.get(k)!;
      if (!m.has(campaignId)) throw new Error(`campaign-service lists no campaign ${campaignId} for brand ${brandId}`);
      return m.get(campaignId) ?? null;
    };
    for (const u of units) {
      const unitId = String(u.id);
      // The unit as every run-time read sees it (canonical leg spelling): `fetchCampaignPipe`, the script-strategy read's own.
      const pipe = await fetchCampaignPipe(unitId);
      if (!pipe.found) continue;
      const campaignId = pipe.salesFunnelCampaignId ?? str(u.salesFunnelCampaignId)!;
      const orgId = pipe.orgId ?? str(u.orgId)!;
      const featureSlug = pipe.featureSlug ?? str(u.featureSlug)!;
      const legKey = pipe.legKey ?? str(u.legKey)!;
      const brandId = pipe.brandId;
      const base: CarryRow = { campaignId, unitId, orgId, featureSlug, legKey, outcome: null, strategyId: null, carriedFrom: null, result: "failed", detail: null };
      try {
        const engine = await engineOutcomeOfPipe(featureSlug, legKey);
        if (!engine || !brandId) {
          rows.push({ ...base, result: "no_engine", detail: engine ? "the unit names no brand" : "the catalogue knows no Engine on this pipe" });
          continue;
        }
        const [played, briefed] = await Promise.all([
          playOfLegRead(featureSlug, legKey, pipe.salesFunnelId),
          briefPlayOfUnit({ salesFunnelCampaignId: campaignId, orgId, brandId, featureSlug, legKey }),
        ]);
        const strategyId = briefed?.strategyId ?? (played ? played.answer.strategyId || null : null);
        const carriedFrom = briefed?.playId ?? played?.answer.id ?? null;
        const row = { ...base, outcome: engine.outcome, strategyId, carriedFrom };
        if (!briefed && played && played.excludedReason("__probe__")?.includes("not catalogued")) {
          rows.push({ ...row, result: "unknown_play", detail: `the unit's funnel names a play its pipe does not catalogue (${played.answer.id})` });
          continue;
        }
        const stored = await readEngineStrategy(campaignId, engine.outcome);
        if (stored) {
          rows.push({ ...row, result: "held", detail: `stored ${stored.source}: ${stored.strategyId ?? "no condition"}` });
          continue;
        }
        const twin = rows.find((r) => r.campaignId === campaignId && r.outcome === engine.outcome && r.unitId !== unitId);
        if (twin && twin.strategyId !== strategyId) {
          rows.push({ ...row, result: "conflict", detail: `unit ${twin.unitId} on the same Engine runs ${twin.strategyId ?? "no condition"}` });
          twin.result = "conflict";
          continue;
        }
        if (twin) {
          rows.push({ ...row, result: twin.result, detail: `same Engine as unit ${twin.unitId}` });
          continue;
        }
        rows.push({ ...row, result: apply ? "pending" : "would_write" });
      } catch (error) {
        rows.push({ ...base, result: "failed", detail: (error as Error).message });
      }
    }
    if (apply) {
      for (const r of rows.filter((x) => x.result === "pending")) {
        try {
          const pipe = await fetchCampaignPipe(r.unitId);
          if (!pipe.found || !pipe.brandId) throw new Error(`campaign-service no longer lists unit ${r.unitId} with a brand`);
          const brief = await briefOf(r.orgId, pipe.brandId, r.campaignId);
          await writeEngineStrategy({
            campaignId: r.campaignId,
            outcome: r.outcome!,
            orgId: r.orgId,
            strategyId: r.strategyId,
            source: "carried",
            briefHash: briefHashOf(brief),
            optionsSignature: null,
            confidence: null,
            model: null,
            carriedFrom: r.carriedFrom,
          });
          r.result = "written";
        } catch (error) {
          r.result = "failed";
          r.detail = (error as Error).message;
        }
      }
    }
    const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.result]: (m[r.result] ?? 0) + 1 }), {});
    console.log(`[features-service] engine strategy carry (${apply ? "APPLY" : "dry run"}): ${JSON.stringify(counts)}`);
    res.json({ apply, counts, rows });
  } catch (error) {
    console.error("[features-service] engine strategy carry failed:", error);
    res.status(502).json({ error: (error as Error).message, reason: "engine_strategy_carry_failed" });
  }
});

export default router;
