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
 *        `childOutcomes {unitId: [outcome]}` also carries the Engines the unit's scripts ASK (message_written for a cold
 *        email, message_sent for an answer...), at the strategy the script read gives them today.
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { briefHashOf, engineStrategyOptions, engineStrategyState } from "../lib/engine-strategy.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";
import { scriptsKeptByStrategy } from "../lib/script-strategy.js";
import { askJev, engineOutcomeOfPipe, labelOfOutcome, listEngineStrategies, readEngineStrategy, writeEngineStrategy } from "../lib/engine-strategy-io.js";
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
  const childOutcomes: Record<string, string[]> =
    req.body?.childOutcomes && typeof req.body.childOutcomes === "object" ? (req.body.childOutcomes as Record<string, string[]>) : {};
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
        // Zero change for EVERY reader: the scripts read the brief's play first, the writer pick and the workflow pick read
        // the funnel's play. When the two differ but keep the same scripts of this Engine, carry the funnel's play (scripts
        // AND writer stay byte-identical); when they keep different scripts, carry the brief's (what scripts run today)
        // and say the writer differs.
        const playedId = played ? played.answer.strategyId || null : null;
        let strategyId = briefed?.strategyId ?? playedId;
        let carriedFrom = briefed?.playId ?? played?.answer.id ?? null;
        let writerDiffers: string | null = null;
        if (briefed && playedId !== briefed.strategyId) {
          const [catalogue, scripts] = await Promise.all([loadPlayCatalogue(), readRunnableScripts()]);
          const own = scripts.filter((s) => s.outcome === engine.outcome);
          const keptBy = (id: string | null) => scriptsKeptByStrategy(own, id ? (catalogue.strategies.get(id) ?? null) : null, catalogue).keptDynasties.join(",");
          if (keptBy(playedId) === keptBy(briefed.strategyId)) {
            strategyId = playedId;
            carriedFrom = played?.answer.id ?? null;
          } else writerDiffers = `the writer and workflow picks read ${playedId ?? "no strategy"}, the scripts ${briefed.strategyId}`;
        }
        if (!briefed && played && played.excludedReason("__probe__")?.includes("not catalogued")) {
          rows.push({ ...base, outcome: engine.outcome, strategyId, carriedFrom, result: "unknown_play", detail: `the unit's funnel names a play its pipe does not catalogue (${played.answer.id})` });
          continue;
        }
        // The unit's own Engine, then every Engine its scripts ASK on its behalf (`childOutcomes[unitId]`, read off the runs
        // the unit's campaign made): a child pick reads the same strategy the script read gives today (brief, else play).
        const scriptRead = briefed?.strategyId ?? playedId;
        const targets = [
          { outcome: engine.outcome, strategyId, detail: writerDiffers },
          ...[...new Set(childOutcomes[unitId] ?? [])].filter((o) => o !== engine.outcome).map((o) => ({ outcome: o, strategyId: scriptRead, detail: "asked by the unit's scripts" })),
        ];
        for (const t of targets) {
          const row = { ...base, outcome: t.outcome, strategyId: t.strategyId, carriedFrom };
          const stored = await readEngineStrategy(campaignId, t.outcome);
          if (stored) {
            rows.push({ ...row, result: "held", detail: `stored ${stored.source}: ${stored.strategyId ?? "no condition"}` });
            continue;
          }
          const twin = rows.find((r) => r.campaignId === campaignId && r.outcome === t.outcome && r.unitId !== unitId && r.result !== "held");
          if (twin && twin.strategyId !== t.strategyId) {
            rows.push({ ...row, result: "conflict", detail: `unit ${twin.unitId} reads ${twin.strategyId ?? "no condition"} on the same Engine` });
            twin.result = "conflict";
            continue;
          }
          if (twin) {
            rows.push({ ...row, result: "same", detail: `same verdict as unit ${twin.unitId}` });
            continue;
          }
          rows.push({ ...row, result: apply ? "pending" : "would_write", detail: t.detail });
        }
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
        rows.push({ ...base, picked: options[0]?.strategyId ?? null, confidence: null, note: "no brief: the Engine's default" });
        continue;
      }
      if (options.length <= 1) {
        rows.push({ ...base, picked: options[0]?.strategyId ?? null, confidence: null, note: "single option" });
        continue;
      }
      try {
        const pick = await askJev(engineStrategyState(brief, { outcome: r.outcome, label: labelOfOutcome(r.outcome) }), options);
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
