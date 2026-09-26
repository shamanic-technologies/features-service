/**
 * GET /brands/:brandId/conversion-rates — the EFFECTIVE conversion rate of every arrow of a brand's
 * sales funnels, and which source it came from (measured on the brand's own leads, stated by hand, or
 * the cross-org median). Every money figure this service states is priced on these rates, so the
 * dashboard's Brand Settings can show the customer exactly what their pipeline rests on.
 *
 * Only the funnels the brand's offers READ (their campaigns' legs; wave C1 reads no declared set) are
 * served, beside every leg of the brand on `legs`, each arrow named in brand-service's own
 * step wording so it joins to the brand-service write. `?funnel=` is retired (wave C2) and refused
 * with a 400. The resolution rules live in
 * `lib/effective-conversion-rates.ts`; nothing is computed here.
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { getBrandEffectiveRates } from "../lib/effective-conversion-rates.js";
import { FUNNEL_RETIRED_BODY, namesRetiredFunnel } from "../lib/retired-funnel-param.js";
import { fetchPricingFunnelsAllOffers } from "../lib/reading-funnels.js";
import { SalesFunnelsUnavailableError } from "../lib/sales-funnels-client.js";

const router = Router();

router.get("/brands/:brandId/conversion-rates", apiKeyAuth, async (req, res) => {
  const { orgId } = req as unknown as AuthenticatedRequest;
  const brandId = req.params.brandId;

  // `?funnel=` is RETIRED (wave C2): refused, never silently ignored. See lib/retired-funnel-param.ts.
  if (namesRetiredFunnel(req.query as Record<string, unknown>)) {
    return res.status(400).json(FUNNEL_RETIRED_BODY);
  }

  try {
    const [rates, declared] = await Promise.all([
      getBrandEffectiveRates(brandId, orgId),
      // The funnels the brand's offers READ (wave C1: their campaigns' legs), across every offer. A brand
      // whose campaigns run no leg yet reads through nothing, so it is served no funnel — never the whole
      // catalogue as if it did. Every LEG is served beside them on `legs`.
      fetchPricingFunnelsAllOffers(brandId, orgId).catch((error) => {
        if (error instanceof SalesFunnelsUnavailableError) return [];
        throw error;
      }),
    ]);
    const sold = new Set(declared.map((f) => f.funnelKey));
    return res.json({
      ...rates,
      funnels: rates.funnels.filter((f) => sold.has(f.funnelKey)),
    });
  } catch (error) {
    console.error(`[features-service] conversion-rates error for brand ${brandId}:`, error);
    return res.status(502).json({ error: "Failed to resolve the brand's conversion rates" });
  }
});

export default router;
