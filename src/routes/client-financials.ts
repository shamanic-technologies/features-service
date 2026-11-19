/**
 * GET /internal/stats/client-financials — what each client pays us, costs us, and the margin we make, since
 * inception, plus fleet totals (DISTRY-PRINCIPAL-1119; compose `lib/client-financials.ts`, reads
 * `lib/client-financials-io.ts`). api-key only; staff-gated at api-service (the vendor cost reveals our margin).
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { ClientFinancialsNotBuiltError, readClientFinancials } from "../lib/client-financials-io.js";

const router = Router();

router.get("/internal/stats/client-financials", apiKeyOnly, async (_req, res) => {
  try {
    res.json(await readClientFinancials());
  } catch (err) {
    if (err instanceof ClientFinancialsNotBuiltError) {
      res.status(503).json({ error: "client_financials_not_computed_yet", detail: err.message });
      return;
    }
    console.error("[features-service] GET /internal/stats/client-financials failed:", err);
    res.status(502).json({ error: "client_financials_unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
