/**
 * GET /internal/stats/saas-cash — the cash the distribute.you SaaS (self-serve) collected, agency and our
 * own orgs excluded: one bar per ISO week and a cumulative line per UTC day since the first payment ever
 * (SAAS-CASH-1121, owner 2026-11-21 choice 'A': cash collected, never consumed spend). api-key only;
 * staff-gated at api-service (`/v1/features/audit/saas-cash`). Compose `lib/saas-cash.ts`, reads
 * `lib/saas-cash-io.ts`.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { readSaasCash } from "../lib/saas-cash-io.js";

const router = Router();

router.get("/internal/stats/saas-cash", apiKeyOnly, async (_req, res) => {
  try {
    res.json(await readSaasCash());
  } catch (err) {
    console.error("[features-service] GET /internal/stats/saas-cash failed:", err);
    res.status(502).json({ error: "saas_cash_unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
