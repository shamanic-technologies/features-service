/**
 * GET /offers/:offerId/campaign-brief?brandId=&salesFunnelId=|salesFunnelIds=a,b[&target=] (HUMAN-BRIEF-1121, owner 2026-11-21: « Prefill un
 * résumé de sa campaign en langage naturel, court concis, clair. Qu'il peut cliquer pour éditer »).
 * The brief a campaign WOULD start with, before it exists: one or two plain sentences on what it aims at and how, from
 * what the client picked (offer, the funnel of the card, its Target). The onboarding shows it editable and sends it as the
 * campaign's `brief`. Org-scoped; the same inputs answer the same text (stored per input fingerprint, `human-brief-io`).
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { assertBrandHeld, BrandOwnershipError } from "../lib/brand-ownership.js";
import { funnelById } from "../lib/agent-catalogue.js";
import { humanBriefInputOf } from "../lib/human-brief.js";
import { OfferNotOfBrandError, readOfferBriefContext, writeHumanBrief } from "../lib/human-brief-io.js";
import { offerLifetimeRevenue } from "../lib/offer-lifetime-revenue.js";
import { loadCatalogueModelForLifetimeRevenue } from "./agent-catalogue.js";

const router = Router();

const param = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

router.get("/offers/:offerId/campaign-brief", apiKeyAuth, async (req, res) => {
  const auth = req as unknown as AuthenticatedRequest & { params: { offerId: string } };
  const offerId = auth.params.offerId;
  const brandId = param(req.query.brandId);
  const salesFunnelId = param(req.query.salesFunnelId);
  const target = param(req.query.target);
  // ONE-CAMPAIGN-VOLUME-1122: the funnels ONE campaign runs underneath, comma separated (its brief = their union).
  const salesFunnelIds = [...new Set((param(req.query.salesFunnelIds) ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""))];
  if (!brandId) return void res.status(400).json({ error: "brandId is required", reason: "brand_id_required" });
  try {
    await assertBrandHeld(brandId, { orgId: auth.orgId, userId: auth.userId, runId: auth.runId });
    const ltr = await offerLifetimeRevenue(null);
    const [context, model] = await Promise.all([readOfferBriefContext(auth.orgId, brandId, offerId), loadCatalogueModelForLifetimeRevenue(ltr.usd, ltr.source)]);
    for (const id of [...(salesFunnelId ? [salesFunnelId] : []), ...salesFunnelIds])
      if (!funnelById(model, id)) return void res.status(400).json({ error: `no catalogue funnel ${id}`, reason: "sales_funnel_unknown" });
    if (target && !model.steps.has(target)) return void res.status(400).json({ error: `no catalogue step ${target}`, reason: "target_unknown" });
    const written = await writeHumanBrief(humanBriefInputOf(model, context, { salesFunnelId, salesFunnelIds, target, replacing: null }));
    res.json({ offerId, brandId, salesFunnelId, salesFunnelIds, target, brief: written.brief, model: written.model });
  } catch (err) {
    if (err instanceof BrandOwnershipError) return void res.status(404).json({ error: err.message, reason: "brand_not_found" });
    if (err instanceof OfferNotOfBrandError) return void res.status(404).json({ error: err.message, reason: "offer_not_found" });
    console.error(`[features-service] campaign brief for offer ${offerId} (brand ${brandId}):`, err);
    res.status(502).json({ error: (err as Error).message, reason: "brief_unwritable" });
  }
});

export default router;
