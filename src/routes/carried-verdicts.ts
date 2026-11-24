/**
 * CARRIED VERDICTS A JUDGED-ROW READING WOULD RE-ASK (PLAN-RECURSIVE-PER-ENGINE-1124; pure rule `lib/carried-verdicts.ts`):
 *
 *   GET /internal/engine-strategies/carried-reask   (api key, staff, not proxied)
 *
 * A DRY read: every stored verdict, today's runnable scripts and the play catalogue, compared in memory. No Jev call, no
 * write, no campaign-service read. It measures a leftover (`engineStrategyNeed` never re-asks a `carried` row when the
 * Engine's options move); it does not change it.
 */
import { Router, type Request, type Response } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { carriedVerdictsToReask } from "../lib/carried-verdicts.js";
import { listEngineStrategies } from "../lib/engine-strategy-io.js";
import { loadPlayCatalogue } from "../lib/plays-store.js";
import { readRunnableScripts } from "../lib/script-catalogue-client.js";

const router = Router();

router.get("/internal/engine-strategies/carried-reask", apiKeyOnly, async (_req: Request, res: Response) => {
  try {
    const [stored, scripts, catalogue] = await Promise.all([listEngineStrategies(null), readRunnableScripts(), loadPlayCatalogue()]);
    res.json({ computedAt: new Date().toISOString(), ...carriedVerdictsToReask(stored, scripts, catalogue) });
  } catch (error) {
    console.error("[features-service] carried verdicts read failed:", error);
    res.status(502).json({ error: (error as Error).message, reason: "carried_verdicts_unreadable" });
  }
});

export default router;
