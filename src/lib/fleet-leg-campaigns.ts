/**
 * EVERY CAMPAIGN, ACROSS EVERY ORG, THAT PERFORMS ONE LEG OF ONE CHANNEL — the population a
 * leg-scoped fleet workflow curve (`/public/stats/workflow-return-history?leg=`) is restricted to.
 *
 * A campaign identity is (org, brand, offer, LEG, channel), and campaign-service owns it: the leg a
 * campaign performs is its own stated `legKey`, read here verbatim, never inferred. A row stating no
 * leg (the pre-leg ancestors) performs no leg and is in no leg's population.
 *
 * ONE call (`GET /campaigns/list`, every org's rows), filtered locally — a per-brand read would be one
 * round trip per pair for the same answer. FAIL-LOUD: a leg population we could not read must never
 * silently widen to the fleet or narrow to nobody.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { matchFunnelLegKey } from "./funnel-legs.js";

export interface FleetLegCampaign {
  campaignId: string;
  orgId: string;
  /** The brand it funds, or null for a legacy row naming none (it still carries spend). */
  brandId: string | null;
}

/** PURE: keep the rows of `featureSlug` whose stated leg IS `legKey` (canonical). */
export function filterLegCampaigns(rows: unknown[], featureSlug: string, legKey: string): FleetLegCampaign[] {
  return rows.flatMap((raw) => {
    const c = raw as { id?: unknown; orgId?: unknown; featureSlug?: unknown; legKey?: unknown; brandId?: unknown; brandIds?: unknown };
    if (typeof c.id !== "string" || typeof c.orgId !== "string") return [];
    if (c.featureSlug !== featureSlug) return [];
    if (typeof c.legKey !== "string" || matchFunnelLegKey(c.legKey) !== legKey) return [];
    const first = Array.isArray(c.brandIds) ? c.brandIds[0] : undefined;
    const brandId = typeof first === "string" ? first : typeof c.brandId === "string" ? c.brandId : null;
    return [{ campaignId: c.id, orgId: c.orgId, brandId }];
  });
}

export async function fetchFleetLegCampaigns(featureSlug: string, legKey: string): Promise<FleetLegCampaign[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  const response = await fetchWithRetry(`${url}/campaigns/list`, { headers: { "x-api-key": apiKey } });
  if (!response.ok) {
    throw new Error(`campaign-service /campaigns/list failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { campaigns?: unknown };
  if (!Array.isArray(data.campaigns)) throw new Error("campaign-service /campaigns/list returned no campaigns array");
  return filterLegCampaigns(data.campaigns, featureSlug, legKey);
}
