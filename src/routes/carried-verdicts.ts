/**
 * CARRIED VERDICTS A JUDGED-ROW READING WOULD RE-ASK (PLAN-RECURSIVE-PER-ENGINE-1124; pure rule `lib/carried-verdicts.ts`):
 *
 *   GET /internal/engine-strategies/carried-reask[?judge=dry[&campaignIds=a,b]]   (api key, staff, not proxied)
 *
 * A DRY read: every stored verdict, today's runnable scripts and the play catalogue, compared in memory. No Jev call, no
 * write, no campaign-service read. It measures a leftover (`engineStrategyNeed` never re-asks a `carried` row when the
 * Engine's options move); it does not change it.
 *
 * `?judge=dry` (opt-in; absent = the read above, byte for byte): each listed row that would call the judge is asked of
 * the SAME judge the live read asks (`askJev`: same options, question and state builders, the campaign's brief as
 * campaign-service serves it now), as a staff experiment. NOTHING is stored: this file never calls `writeEngineStrategy`
 * nor `engineStrategyOfCampaign` (the only two paths that write a verdict), so no campaign changes what it runs.
 * Bounded: at most `DRY_JUDGE_MAX_CALLS` rows per request (more = 422 before the first call, narrow with `campaignIds`),
 * `DRY_JUDGE_CONCURRENCY` at once; a row that fails carries its error, never an "unchanged".
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { DRY_JUDGE_MAX_CALLS, carriedDryRow, carriedDryTotals, carriedVerdictsToReask, type CarriedDryRow, type CarriedVerdictRow, type DryJudgeAnswer } from "../lib/carried-verdicts.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { briefHashOf, engineStrategyOptions, engineStrategyState, type StoredEngineStrategy } from "../lib/engine-strategy.js";
import { askJev, labelOfOutcome, listEngineStrategies } from "../lib/engine-strategy-io.js";
import { fetchFleetCampaignRows } from "../lib/fleet-leg-campaigns.js";
import { CARRIED_DRY_JUDGE_SUPPORT } from "../lib/platform-caller.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { fetchSalesFunnelCampaigns } from "../lib/sales-funnel-campaigns-client.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";

const router = Router();

const DRY_JUDGE_CONCURRENCY = 4;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Who holds each campaign (its org and brand, off campaign-service's unit rows) and whether a unit of it runs today. */
async function campaignOwners(): Promise<Map<string, { orgId: string; brandId: string; running: boolean }>> {
  const owners = new Map<string, { orgId: string; brandId: string; running: boolean }>();
  for (const u of (await fetchFleetCampaignRows()) as Array<Record<string, unknown>>) {
    const id = str(u.salesFunnelCampaignId);
    const orgId = str(u.orgId);
    const brandId = Array.isArray(u.brandIds) ? str(u.brandIds[0]) : null;
    if (!id || !orgId || !brandId) continue;
    const held = owners.get(id);
    owners.set(id, { orgId, brandId, running: (held?.running ?? false) || u.status === "ongoing" });
  }
  return owners;
}

/** The dry judge over the listed rows. Reads only; the one outbound POST is the judge's question (`askJev`). */
async function dryJudge(
  targets: readonly CarriedVerdictRow[],
  stored: readonly StoredEngineStrategy[],
  scripts: Awaited<ReturnType<typeof readRunnableScripts>>,
  catalogue: Awaited<ReturnType<typeof loadPlayCatalogue>>,
): Promise<CarriedDryRow[]> {
  const owners = await campaignOwners();
  // The brief as the live read takes it: campaign-service's row of the campaign, asked once per (org, brand).
  const lists = new Map<string, ReturnType<typeof fetchSalesFunnelCampaigns>>();
  const briefOf = async (campaignId: string, o: { orgId: string; brandId: string }): Promise<string | null> => {
    const key = `${o.orgId}|${o.brandId}`;
    if (!lists.has(key)) lists.set(key, fetchSalesFunnelCampaigns(o.brandId, null, { orgId: o.orgId }));
    const row = (await lists.get(key)!).find((r) => r.id === campaignId);
    if (!row) throw new Error(`campaign-service lists no campaign ${campaignId} for brand ${o.brandId}`);
    return row.brief ?? null;
  };
  const verdictOf = new Map(stored.map((r) => [`${r.campaignId}|${r.outcome}`, r]));
  return mapWithConcurrency(targets, DRY_JUDGE_CONCURRENCY, async (row): Promise<CarriedDryRow> => {
    const owner = owners.get(row.campaignId) ?? null;
    const facts = { running: owner?.running ?? null, briefMovedSinceVerdict: null as boolean | null };
    const answer = async (): Promise<DryJudgeAnswer> => {
      if (!owner) throw new Error(`campaign-service lists no unit for campaign ${row.campaignId}: its brand, so its brief, cannot be read`);
      const brief = await briefOf(row.campaignId, owner);
      const briefHash = briefHashOf(brief);
      facts.briefMovedSinceVerdict = briefHash !== (verdictOf.get(`${row.campaignId}|${row.outcome}`)?.briefHash ?? null);
      if (briefHash === null) return { kind: "no_brief_today" };
      // The options the live read builds for this row: the Engine's, plus the strategy the verdict holds.
      const options = engineStrategyOptions(row.outcome, scripts, catalogue, row.storedStrategyId ? [row.storedStrategyId] : []);
      const pick = options.length <= 1 ? { option: options[0]!, confidence: 1, model: "single_option" } : await askJev(engineStrategyState(brief!, { outcome: row.outcome, label: labelOfOutcome(row.outcome) }, { scripts, options, c: catalogue }), options, CARRIED_DRY_JUDGE_SUPPORT);
      return { kind: "picked", strategyId: pick.option.strategyId, confidence: pick.confidence, model: pick.model };
    };
    try {
      return carriedDryRow(row, await answer(), facts, scripts, catalogue);
    } catch (error) {
      return carriedDryRow(row, { kind: "failed", error: (error as Error).message }, facts, scripts, catalogue);
    }
  });
}

router.get("/internal/engine-strategies/carried-reask", apiKeyOnly, async (req: Request, res: Response) => {
  const judge = req.query.judge;
  if (judge !== undefined && judge !== "dry") {
    res.status(400).json({ error: "judge must be `dry` when given", reason: "judge_unrecognised" });
    return;
  }
  try {
    const [stored, scripts, catalogue] = await Promise.all([listEngineStrategies(null), readRunnableScripts(), loadPlayCatalogue()]);
    const report = carriedVerdictsToReask(stored, scripts, catalogue);
    if (judge === undefined) {
      res.json({ computedAt: new Date().toISOString(), ...report });
      return;
    }
    const only = typeof req.query.campaignIds === "string" && req.query.campaignIds !== "" ? new Set(req.query.campaignIds.split(",")) : null;
    const targets = report.rows.filter((r) => r.wouldCallJudge && (!only || only.has(r.campaignId)));
    if (targets.length > DRY_JUDGE_MAX_CALLS) {
      res.status(422).json({ error: `${targets.length} rows would call the judge, over the ${DRY_JUDGE_MAX_CALLS} one request may ask: name fewer campaigns in campaignIds`, reason: "too_many_judge_calls", rowsToJudge: targets.length, maxJudgeCalls: DRY_JUDGE_MAX_CALLS });
      return;
    }
    const rows = await dryJudge(targets, stored, scripts, catalogue);
    const totals = carriedDryTotals(rows);
    console.log(`[features-service] carried verdicts dry judge: ${totals.rowsJudged} judged of ${totals.rowsAsked}, ${totals.rowsChanging} would change over ${totals.campaignsChanging} campaign(s), ${totals.rowsFailed} failed, nothing stored`);
    res.json({ computedAt: new Date().toISOString(), ...report, dryJudge: { stored: false, maxJudgeCalls: DRY_JUDGE_MAX_CALLS, campaignIds: only ? [...only].sort() : null, ...totals, rows } });
  } catch (error) {
    console.error("[features-service] carried verdicts read failed:", error);
    res.status(502).json({ error: (error as Error).message, reason: "carried_verdicts_unreadable" });
  }
});

export default router;
