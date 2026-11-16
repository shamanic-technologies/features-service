/**
 * THE SCRIPT RATING ON VALUE (SCRIPT-VALUE-RATING-1113, owner 2026-11-13; rule `lib/script-value-rating.ts`).
 *   GET /internal/script-ratings                      (api key, staff) every outcome's value + every script's rating.
 *   GET /internal/script-pick?outcome=&dynasties=a,b   (api key) one Thompson draw among the candidates the caller keeps
 *                                                      (the scripts the campaign's strategy keeps, runnable today).
 * The pick reads a decision figure (value credited per dollar): it is never a return and is served to no customer.
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { LEAD_STATES } from "../lib/lead-states.js";
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { readRunnableScripts, readScriptMerges, scriptDynastyKey, type RunnableScript } from "../lib/script-catalogue-client.js";
import { applyMerges, applyReports, askedRatings, outcomeValues, pickScript, rehomeGroups, scriptRatings, type AskedRatings, type OutcomeValue, type ReachGroup, type ScriptRating } from "../lib/script-value-rating.js";
import { readOutcomeChains, readReportedDecisions } from "../lib/script-value-rating-io.js";
import { listUnitReports } from "../lib/unit-client-reports-store.js";
import { readLlmCostNames } from "../lib/llm-cost-names-client.js";
import { llmDynastyIndex, readLlmDynasties } from "../lib/llm-dynasties.js";
import { llmTacticsOf } from "../lib/script-engine-board.js";
import { servedByScript, splitByServedModel, statedLlmsOf, type OtherModelRuns, type ServedByRow } from "../lib/served-model.js";
import { loadCatalogueModelForLifetimeRevenue } from "./agent-catalogue.js";

const router = Router();

/** The outcome worth the lifetime revenue: the top state of the lead's interest family (a Paid client), read off the states. */
const ANCHOR_OUTCOME = [...LEAD_STATES].filter((s) => s.family === "interest").sort((a, b) => b.rank - a.rank)[0]!.key;

export interface ScriptRatingBody {
  /** When runs-service built the chains these figures read. */
  builtAt: string;
  lifetimeRevenueUsd: number | null;
  lifetimeRevenueSource: string | null;
  values: OutcomeValue[];
  scripts: ScriptRating[];
  /** Client reports (an edit, or a "Report"): how many Units, and how many script decisions they took the credit of. */
  clientReports: { units: number; decisions: number };
  /**
   * SERVED-MODEL-1116: decisions another model wrote (a fallback, or history a dynasty inherited before its re-point),
   * by script and the LLM dynasties the ledger names. Out of every script's score. Empty while the ledger names none.
   */
  otherModels: OtherModelRuns[];
  /**
   * ONE-WRITER-N-MODELS-1116: the ratings per place a script was asked from, finest first in the pick's cascade:
   * per asking script, then per asking Engine (`scripts` = the candidate alone). Empty while the ledger names no asker.
   */
  asked: Array<{ askedBy: string; level: "script" | "engine"; scripts: ScriptRating[] }>;
}

/**
 * SERVED-MODEL-1116: split the groups by the model that served them. The cost-name catalogue and the dynasties are read
 * only when the ledger names writer cost names on some group (FAIL-LOUD then, like every Rating input); else every group
 * is its script's own, byte for byte as before.
 */
export async function attributeServedModels(
  groups: readonly ReachGroup[],
  runnable: readonly RunnableScript[],
): Promise<{ own: ReachGroup[]; otherModels: OtherModelRuns[]; servedBy: Map<string, ServedByRow[]> }> {
  if (!groups.some((g) => Array.isArray(g.writerCostNames))) return { own: [...groups], otherModels: [], servedBy: new Map() };
  const [llmOfCostName, dynasties] = await Promise.all([readLlmCostNames(), readLlmDynasties()]);
  const index = llmDynastyIndex(dynasties);
  const stated = statedLlmsOf(
    runnable.map((s) => ({ key: scriptDynastyKey(s), llms: llmTacticsOf(s.tactics) })),
    (name) => index.dynastyOfName(name)?.slug ?? null,
  );
  const { own, otherModels } = splitByServedModel({ groups, stated, llmOfCostName });
  return { own, otherModels, servedBy: servedByScript({ groups, stated, llmOfCostName }) };
}

/** The whole Rating: the served body, plus what Monitoring's board reads beside it (the groups and runnable scripts). */
export async function buildScriptRating(): Promise<
  ScriptRatingBody & { valueMap: Map<string, OutcomeValue>; groups: ReachGroup[]; runnable: RunnableScript[]; servedBy: Map<string, ServedByRow[]>; askedRatings: AskedRatings }
> {
  const [chains, ltr, runnable, reports, merges] = await Promise.all([readOutcomeChains(), offerLifetimeRevenue(null), readRunnableScripts(), listUnitReports(), readScriptMerges()]);
  const reported = reports.length ? await readReportedDecisions(reports) : [];
  const model = await loadCatalogueModelForLifetimeRevenue(ltr.usd, ltr.source);
  const declared = new Map<string, number>();
  for (const [key, step] of model.steps) if (step.valueUsd !== null && step.valueUsd > 0) declared.set(key, step.valueUsd);
  const valueMap = outcomeValues({ steps: chains.steps, anchor: { outcome: ANCHOR_OUTCOME, valueUsd: ltr.usd }, declared });
  // A merged per-model copy's decisions count for each survivor at its place (before the re-homing of retired names).
  const groups = rehomeGroups(applyMerges(applyReports(chains.groups, reported), merges), runnable.map(scriptDynastyKey));
  const served = await attributeServedModels(groups, runnable);
  const asked = askedRatings({ groups: served.own, values: valueMap });
  return {
    builtAt: chains.builtAt,
    lifetimeRevenueUsd: ltr.usd,
    lifetimeRevenueSource: ltr.source,
    values: [...valueMap.values()].sort((a, b) => b.valueUsd - a.valueUsd || a.outcome.localeCompare(b.outcome)),
    scripts: scriptRatings({ groups: served.own, values: valueMap }),
    clientReports: { units: reports.length, decisions: reported.length },
    otherModels: served.otherModels,
    asked: [
      ...[...asked.byScript].map(([askedBy, scripts]) => ({ askedBy, level: "script" as const, scripts })),
      ...[...asked.byEngine].map(([askedBy, scripts]) => ({ askedBy, level: "engine" as const, scripts })),
    ].sort((a, b) => a.askedBy.localeCompare(b.askedBy) || a.level.localeCompare(b.level)),
    askedRatings: asked,
    valueMap,
    // The board's runs per day read the same decisions as each row's runs: the script's own combination only.
    groups: served.own,
    runnable,
    servedBy: served.servedBy,
  };
}

router.get("/internal/script-ratings", apiKeyOnly, async (_req: Request, res: Response) => {
  try {
    const { valueMap: _valueMap, groups: _groups, runnable: _runnable, servedBy: _servedBy, askedRatings: _askedRatings, ...body } = await buildScriptRating();
    res.json(body);
  } catch (error) {
    console.error("[features-service] script ratings:", error);
    res.status(502).json({ error: (error as Error).message, reason: "script_rating_unreadable" });
  }
});

router.get("/internal/script-pick", apiKeyOnly, async (req: Request, res: Response) => {
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
  const dynasties = typeof req.query.dynasties === "string" ? req.query.dynasties.split(",").map((d) => d.trim()).filter(Boolean) : [];
  // ONE-WRITER-N-MODELS-1116: the script asking for this pick (absent = a campaign's own run, as before).
  const askedBy = typeof req.query.askedBy === "string" && req.query.askedBy.trim() !== "" ? req.query.askedBy.trim() : null;
  if (!outcome || !dynasties.length || dynasties.some((d) => !d.startsWith(`${outcome}/`)) || (askedBy !== null && !/^[^/]+\/[^/]+$/.test(askedBy))) {
    res.status(400).json({ error: "outcome and dynasties (comma list of <outcome>/<dynasty> of that outcome) are required; askedBy, when sent, is <outcome>/<dynasty>", reason: "script_pick_unrecognised" });
    return;
  }
  try {
    const b = await buildScriptRating();
    const pick = pickScript({ outcome, candidates: dynasties, ratings: b.scripts, values: b.valueMap, rng: Math.random, asked: askedBy ? { by: askedBy, ratings: b.askedRatings } : null });
    res.json({ ...pick, ...(askedBy ? { askedBy } : {}), builtAt: b.builtAt });
  } catch (error) {
    console.error(`[features-service] script pick ${outcome}:`, error);
    res.status(502).json({ error: (error as Error).message, reason: "script_rating_unreadable" });
  }
});

export default router;
