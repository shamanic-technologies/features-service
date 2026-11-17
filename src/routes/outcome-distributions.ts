/**
 * OUTCOME-FORECAST-1117, SILVER, staff read (api key):
 *   GET /internal/outcome-distributions?scope=fleet|brand|campaign[&scopeId=][&fromKey=][&toKey=]
 * What is MEASURED on the ledger's Units at one scope, as stored by the daily sweep (`lib/outcome-silver-io.ts`): a cost
 * row per outcome and a row per transition (yield + delay), each with its sample size. Never computed on the read.
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { readSilverStats, readSilverSweepRecord } from "../lib/outcome-silver-io.js";
import { FLEET_SCOPE_ID, type SilverScope } from "../lib/outcome-silver.js";

const router = Router();
const SCOPES: readonly SilverScope[] = ["fleet", "brand", "campaign"];

router.get("/internal/outcome-distributions", apiKeyOnly, async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, unknown>;
    const scope = q.scope as SilverScope;
    if (!SCOPES.includes(scope)) return void res.status(400).json({ error: "scope must be one of: fleet, brand, campaign", reason: "scope_unrecognised" });
    const scopeId = scope === "fleet" ? FLEET_SCOPE_ID : typeof q.scopeId === "string" && q.scopeId !== "" ? q.scopeId : null;
    if (scopeId === null) return void res.status(400).json({ error: "scopeId is required for a brand or a campaign", reason: "scope_id_missing" });
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
    const [sweep, rows] = await Promise.all([readSilverSweepRecord(), readSilverStats(scope, scopeId, { fromKey: str(q.fromKey), toKey: str(q.toKey) })]);
    if (sweep === null) return void res.status(503).json({ error: "The first sweep has not completed yet (the ledger's Units are still being copied)", reason: "outcome_distributions_not_built_yet" });
    res.json({
      scope,
      scopeId,
      computedAt: sweep.sweptAt,
      unitsHeld: sweep.units,
      unitCosts: rows.flatMap((r) => (r.body.kind === "unit_cost" ? [{ outcomeKey: r.toKey, ...r.body.stat }] : [])),
      transitions: rows.flatMap((r) => (r.body.kind === "transition" ? [{ fromKey: r.fromKey, toKey: r.toKey, ...r.body.stat }] : [])),
    });
  } catch (err) {
    console.error("[features-service] outcome distributions read failed:", err);
    res.status(502).json({ error: "Failed to read the outcome distributions", reason: "outcome_distributions_unreadable" });
  }
});

export default router;
