import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { checkDrift, keeperStatus, precomputeSiblingScopes } from "../lib/view-keeper.js";

/**
 * Operator routes for the Gold serving layer (`lib/view-keeper.ts`). Service-key only, never proxied by
 * the gateway: they drive computes, so they are a staff tool, not a customer surface.
 */
const router = Router();

/** The keeper's last precompute round and the facts gate's counters since boot. */
router.get("/internal/view-cache/keeper", apiKeyOnly, (_req, res) => {
  res.json(keeperStatus());
});

/** Run one precompute round now and answer its report. */
router.post("/internal/view-cache/keeper/run", apiKeyOnly, async (_req, res) => {
  try {
    res.json(await precomputeSiblingScopes());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * Compare stored cells with a fresh computation. `mode=moment` refreshes each cell then verifies it at
 * once (stored vs fresh at the same moment); `mode=stored` compares what is served right now.
 */
router.get("/internal/view-cache/drift", apiKeyOnly, async (req, res) => {
  const mode = req.query.mode === "stored" ? "stored" : req.query.mode === "moment" || req.query.mode === undefined ? "moment" : null;
  if (mode === null) return res.status(400).json({ error: "mode must be one of: moment, stored" });
  const limit = Number(req.query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) return res.status(400).json({ error: "limit must be an integer 1-2000" });
  const readWithinHours = req.query.readWithinHours === undefined ? undefined : Number(req.query.readWithinHours);
  if (readWithinHours !== undefined && !(readWithinHours > 0)) return res.status(400).json({ error: "readWithinHours must be > 0" });
  try {
    res.json(
      await checkDrift({
        mode,
        limit,
        brandId: typeof req.query.brandId === "string" ? req.query.brandId : undefined,
        view: typeof req.query.view === "string" ? req.query.view : undefined,
        readWithinMs: readWithinHours === undefined ? undefined : readWithinHours * 3_600_000,
      }),
    );
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
