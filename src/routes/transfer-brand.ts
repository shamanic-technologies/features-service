import { Router } from "express";
import { z } from "zod";
import { apiKeyOnly } from "../middleware/auth.js";
import { transferBrand } from "../lib/transfer-brand.js";
import { StatedAmountConflictError } from "../lib/stated-monthly-amounts-store.js";
import { viewCacheRole } from "../lib/view-refresher.js";

/**
 * `POST /internal/transfer-brand` — the fleet brand-transfer contract (see `lib/transfer-brand.ts`).
 * Service-key only; brand-service is the caller.
 */
const router = Router();

export const TransferBrandBody = z.object({
  sourceBrandId: z.string().uuid(),
  sourceOrgId: z.string().uuid(),
  targetOrgId: z.string().uuid(),
  targetBrandId: z.string().uuid().optional(),
});

/**
 * The view refresher is a separate process holding its own lead copies and memo. The route is
 * idempotent, so the refresher simply runs it too (its DB half is then a no-op). A refresher that is
 * not up holds nothing (it respawns empty); one that is up and refuses fails the call so the
 * orchestrator retries.
 */
async function forwardToRefresher(body: unknown): Promise<void> {
  const port = process.env.VIEW_REFRESHER_PORT;
  if (viewCacheRole() !== "server" || !port) return;
  const res = await fetch(`http://127.0.0.1:${port}/internal/transfer-brand`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`view refresher answered ${res.status}: ${await res.text()}`);
}

router.post("/internal/transfer-brand", apiKeyOnly, async (req, res) => {
  const parsed = TransferBrandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const updatedTables = await transferBrand(parsed.data);
    await forwardToRefresher(parsed.data);
    res.json({ updatedTables });
  } catch (err) {
    if (err instanceof StatedAmountConflictError) {
      res.status(409).json({ error: err.message, reason: "stated_amount_conflict" });
      return;
    }
    console.error("[features-service] transfer-brand failed:", err);
    res.status(500).json({ error: (err as Error).message || "Internal server error" });
  }
});

export default router;
