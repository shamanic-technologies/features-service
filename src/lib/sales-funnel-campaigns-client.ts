/**
 * campaign-service's SALES FUNNEL CAMPAIGNS (brand x offer x sales funnel, one UNIT campaign per pipe).
 * Read by the funnel table (`routes/sales-funnel-campaigns.ts`) and by the per-pipe spend attribution
 * (`lib/pipe-spend-attribution.ts`). Lives in lib so a lib never imports a route.
 */
import { fetchWithRetry } from "./fetch-retry.js";

export interface SalesFunnelUnitRow {
  campaignId: string;
  pipeId: string;
  featureSlug: string;
  legKey: string;
  status: string;
}

export interface SalesFunnelCampaignRow {
  id: string;
  brandId: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName: string;
  status: string;
  stopReason: string | null;
  createdAt: string;
  units: SalesFunnelUnitRow[];
}

/** campaign-service's funnel campaigns of one brand (optionally one offer), org-scoped. FAIL-LOUD. */
export async function fetchSalesFunnelCampaigns(
  brandId: string,
  offerId: string | null,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<SalesFunnelCampaignRow[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const params = new URLSearchParams({ brandId });
  if (offerId) params.set("offerId", offerId);
  const reqHeaders: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  const response = await fetchWithRetry(`${url}/sales-funnel-campaigns?${params}`, { headers: reqHeaders }, { shareForMs: 30_000 });
  if (!response.ok) throw new Error(`[features-service] campaign-service /sales-funnel-campaigns failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { salesFunnelCampaigns?: SalesFunnelCampaignRow[] };
  if (!Array.isArray(data.salesFunnelCampaigns)) throw new Error("[features-service] campaign-service /sales-funnel-campaigns returned no salesFunnelCampaigns array");
  return data.salesFunnelCampaigns;
}
