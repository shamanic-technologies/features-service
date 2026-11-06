/**
 * OUTCOME-FINEST-1106: `GET /brands/:brandId/published-units/:outcomeKey[?pricing=]`, the customer Outcome page of one
 * published outcome (Threads posts, X posts, LinkedIn posts, newsletter emails): every Unit row with its creative and
 * what it led to, the totals, $ per signup on ours, the day series. Org-scoped (x-org-id); the brand must be the org's.
 * Rule in `lib/published-units.ts`, reads in `lib/published-units-io.ts`.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { isPublishedOutcomeKey, PUBLISHED_OUTCOME_KEYS } from "../lib/published-units.js";
import { readPublishedUnits } from "../lib/published-units-io.js";

const router = Router();

router.get("/brands/:brandId/published-units/:outcomeKey", apiKeyAuth, async (req, res) => {
  try {
    const auth = req as AuthenticatedRequest & { params: { brandId: string; outcomeKey: string } };
    const { brandId, outcomeKey } = auth.params;
    if (!isPublishedOutcomeKey(outcomeKey)) {
      return void res.status(400).json({ error: `outcomeKey must be one of: ${PUBLISHED_OUTCOME_KEYS.join(", ")}`, reason: "outcome_not_served" });
    }
    // NET by default: what the org pays, discounts applied (every money reader asks net).
    const raw = req.query.pricing;
    if (raw !== undefined && raw !== "gross" && raw !== "net") return void res.status(400).json({ error: "pricing must be one of: gross, net", reason: "pricing_unrecognised" });
    const pricing = raw === "gross" ? "gross" : "net";
    await assertBrandHeld(brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId });
    const body = await readPublishedUnits(auth.orgId, brandId, outcomeKey, pricing);
    res.json({ brandId, pricing, ...body });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    console.error("[features-service] published units error:", err);
    res.status(502).json({ error: "Failed to read the brand's published Units" });
  }
});

export default router;
