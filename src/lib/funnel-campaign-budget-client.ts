/**
 * What the customer lets ONE funnel campaign spend per day (billing-service's stated sales funnel caps): the campaign's own
 * cap when it holds one, else the funnel-wide cap of (offer, funnel). Null = no daily money stated (no cap, a volume only,
 * one-off, reactive). FAIL-LOUD on a refused read (the caller decides to degrade).
 */
import { fetchWithRetry } from "./fetch-retry.js";

export async function fetchFunnelCampaignDailyBudgetUsd(
  brandId: string,
  campaign: { id: string; offerId: string; salesFunnelId: string },
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<number | null> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  const path = `/internal/brands/${encodeURIComponent(brandId)}/sales-funnel-caps?offerId=${encodeURIComponent(campaign.offerId)}`;
  const response = await fetchWithRetry(`${url}${path}`, { headers: h });
  if (!response.ok) throw new Error(`billing-service ${path} failed (${response.status}): ${await response.text()}`);
  const data = (await response.json()) as { caps?: unknown };
  if (!Array.isArray(data.caps)) throw new Error(`billing-service ${path} returned no caps array`);
  const caps = data.caps as Array<Record<string, unknown>>;
  const own = caps.find((c) => c.salesFunnelCampaignId === campaign.id);
  const cap = own ?? caps.find((c) => c.salesFunnelId === campaign.salesFunnelId && !c.salesFunnelCampaignId && c.offerId === campaign.offerId);
  const raw = (cap?.maxBudget as { dailyBudgetCents?: string | number | null } | null | undefined)?.dailyBudgetCents;
  if (raw == null) return null;
  const cents = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(cents)) throw new Error(`billing-service ${path} non-numeric dailyBudgetCents: ${JSON.stringify(raw)}`);
  return cents > 0 ? cents / 100 : null;
}
