/**
 * What ONE funnel campaign can spend (billing-service's MEASURED caps of the campaign: its own cap when it holds one, else
 * the funnel-wide cap it is held to, `capScope`). PROJECTION-CAP-1117: the projection read only the stated daily budget
 * (the brand caps list, unmeasured), so a campaign whose monthly cap was reached (Wide Email, $219.98 of $220 on 2026-11-17)
 * still served « next Lead found in about 2 hours ». It now reads the cap's window, what remains in it and whether it is
 * reached. `dailyBudgetUsd` null = no daily money stated (no cap, a volume only, one-off, reactive). FAIL-LOUD on a refused
 * read (the caller decides).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import type { CapPeriod, SpendCapacityInput } from "./spend-capacity.js";

export interface FunnelCampaignCaps {
  dailyBudgetUsd: number | null;
  budget: SpendCapacityInput["budget"];
  volumeReached: SpendCapacityInput["volumeReached"];
}

const PERIODS: readonly CapPeriod[] = ["daily", "weekly", "monthly", "one_off"];

const usdOf = (raw: unknown, what: string): number | null => {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) throw new Error(`billing-service caps: non-numeric ${what}: ${JSON.stringify(raw)}`);
  return n / 100;
};

/** PURE: billing's campaign caps view -> what the projection needs. */
export function funnelCampaignCapsOf(view: Record<string, unknown>): FunnelCampaignCaps {
  const mb = view.maxBudget as Record<string, unknown> | null | undefined;
  const mv = view.maxVolume as Record<string, unknown> | null | undefined;
  let budget: FunnelCampaignCaps["budget"] = null;
  let dailyBudgetUsd: number | null = null;
  if (mb) {
    const period = mb.period as CapPeriod;
    if (!PERIODS.includes(period)) throw new Error(`billing-service caps: unknown budget period ${JSON.stringify(mb.period)}`);
    const amountUsd = usdOf(mb.amountCents, "amountCents");
    if (amountUsd === null) throw new Error("billing-service caps: maxBudget without amountCents");
    const daily = usdOf(mb.dailyBudgetCents, "dailyBudgetCents");
    dailyBudgetUsd = daily !== null && daily > 0 ? daily : null;
    budget = {
      period,
      amountUsd,
      periodEnd: typeof mb.periodEnd === "string" ? mb.periodEnd : null,
      remainingUsd: usdOf(mb.remainingCents, "remainingCents"),
      reached: typeof mb.reached === "boolean" ? mb.reached : null,
    };
  }
  const volumeReached = mv && mv.reached === true ? { periodEnd: typeof mv.periodEnd === "string" ? mv.periodEnd : null } : null;
  return { dailyBudgetUsd, budget, volumeReached };
}

export async function fetchFunnelCampaignCaps(
  brandId: string,
  campaign: { id: string; offerId: string; salesFunnelId: string },
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<FunnelCampaignCaps> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const h: Record<string, string> = { "x-api-key": apiKey, "x-org-id": headers.orgId, "x-brand-id": brandId };
  if (headers.userId) h["x-user-id"] = headers.userId;
  if (headers.runId) h["x-run-id"] = headers.runId;
  const path =
    `/internal/brands/${encodeURIComponent(brandId)}/offers/${encodeURIComponent(campaign.offerId)}` +
    `/sales-funnels/${encodeURIComponent(campaign.salesFunnelId)}/campaigns/${encodeURIComponent(campaign.id)}/caps`;
  const response = await fetchWithRetry(`${url}${path}`, { headers: h });
  if (!response.ok) throw new Error(`billing-service ${path} failed (${response.status}): ${await response.text()}`);
  return funnelCampaignCapsOf((await response.json()) as Record<string, unknown>);
}
