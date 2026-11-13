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
import { readRunnableScripts, scriptDynastyKey } from "../lib/script-catalogue-client.js";
import { outcomeValues, pickScript, rehomeGroups, scriptRatings, type OutcomeValue, type ScriptRating } from "../lib/script-value-rating.js";
import { readOutcomeChains } from "../lib/script-value-rating-io.js";
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
}

async function build(): Promise<ScriptRatingBody & { valueMap: Map<string, OutcomeValue> }> {
  const [chains, ltr, runnable] = await Promise.all([readOutcomeChains(), offerLifetimeRevenue(null), readRunnableScripts()]);
  const model = await loadCatalogueModelForLifetimeRevenue(ltr.usd, ltr.source);
  const declared = new Map<string, number>();
  for (const [key, step] of model.steps) if (step.valueUsd !== null && step.valueUsd > 0) declared.set(key, step.valueUsd);
  const valueMap = outcomeValues({ steps: chains.steps, anchor: { outcome: ANCHOR_OUTCOME, valueUsd: ltr.usd }, declared });
  const groups = rehomeGroups(chains.groups, runnable.map(scriptDynastyKey));
  return {
    builtAt: chains.builtAt,
    lifetimeRevenueUsd: ltr.usd,
    lifetimeRevenueSource: ltr.source,
    values: [...valueMap.values()].sort((a, b) => b.valueUsd - a.valueUsd || a.outcome.localeCompare(b.outcome)),
    scripts: scriptRatings({ groups, values: valueMap }),
    valueMap,
  };
}

router.get("/internal/script-ratings", apiKeyOnly, async (_req: Request, res: Response) => {
  try {
    const { valueMap: _valueMap, ...body } = await build();
    res.json(body);
  } catch (error) {
    console.error("[features-service] script ratings:", error);
    res.status(502).json({ error: (error as Error).message, reason: "script_rating_unreadable" });
  }
});

router.get("/internal/script-pick", apiKeyOnly, async (req: Request, res: Response) => {
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome.trim() : "";
  const dynasties = typeof req.query.dynasties === "string" ? req.query.dynasties.split(",").map((d) => d.trim()).filter(Boolean) : [];
  if (!outcome || !dynasties.length || dynasties.some((d) => !d.startsWith(`${outcome}/`))) {
    res.status(400).json({ error: "outcome and dynasties (comma list of <outcome>/<dynasty> of that outcome) are required", reason: "script_pick_unrecognised" });
    return;
  }
  try {
    const b = await build();
    res.json({ ...pickScript({ outcome, candidates: dynasties, ratings: b.scripts, values: b.valueMap, rng: Math.random }), builtAt: b.builtAt });
  } catch (error) {
    console.error(`[features-service] script pick ${outcome}:`, error);
    res.status(502).json({ error: (error as Error).message, reason: "script_rating_unreadable" });
  }
});

export default router;
