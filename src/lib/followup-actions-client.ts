import { fetchWithRetry } from "./fetch-retry.js";

/** lead-service's cap on `campaignIds` per request (`MAX_ACTING_CAMPAIGN_IDS`). */
const MAX_ACTING_CAMPAIGN_IDS = 100;

/**
 * Which leads an INTERNAL-leg campaign's worker actually ANSWERED, per acting campaign — lead-service
 * `GET /internal/brands/:brandId/followup-actions?campaignIds=` (service-auth, no org).
 *
 * An internal-leg campaign (the AI meeting booking) serves no lead of its own: it claims people its
 * predecessor holds and answers them. lead-service records each claim and each answer against the
 * campaign whose worker did it (`acting_campaign_id`), apart from the campaign holding the person.
 * Only `acted` (an answer was sent) counts here — a claim can end with nothing sent.
 *
 * Returns acting campaign id → the lead ids it answered. Every asked campaign is present, an empty
 * set when it answered nobody. Fails loud; the route decides whether to degrade.
 */
export async function fetchFollowupActedLeads(
  brandId: string,
  campaignIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");

  const ids = [...new Set(campaignIds)];
  const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (let i = 0; i < ids.length; i += MAX_ACTING_CAMPAIGN_IDS) {
    const chunk = ids.slice(i, i + MAX_ACTING_CAMPAIGN_IDS);
    const response = await fetchWithRetry(
      `${url}/internal/brands/${encodeURIComponent(brandId)}/followup-actions?campaignIds=${chunk.map(encodeURIComponent).join(",")}`,
      { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
    );
    if (!response.ok) {
      throw new Error(`lead-service /internal/brands/:brandId/followup-actions failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as { leads?: unknown };
    if (!Array.isArray(data.leads)) {
      throw new Error("lead-service /internal/brands/:brandId/followup-actions returned no leads array");
    }
    for (const raw of data.leads as Array<Record<string, unknown>>) {
      const acting = raw.actingCampaignId;
      const leadId = raw.leadId;
      const acted = raw.actedCount;
      if (typeof acting !== "string" || typeof leadId !== "string" || typeof acted !== "number") {
        throw new Error("lead-service /internal/brands/:brandId/followup-actions returned a malformed row");
      }
      if (acted > 0) out.get(acting)?.add(leadId);
    }
  }
  return out;
}

/** One (acting campaign, person) row of the follow-up ledger, with WHEN the person was handed and answered. */
export interface FollowupActionRow {
  actingCampaignId: string;
  leadId: string;
  firstClaimedAt: string | null;
  firstActedAt: string | null;
  actedCount: number;
  claimCount: number;
}

/**
 * The follow-up ledger rows of the named ACTING campaigns, as lead-service serves them (one row per acting
 * campaign × person, claimed or answered). Same read as `fetchFollowupActedLeads`, keeping the dates a day-by-day
 * series needs. Fails loud.
 */
export async function fetchFollowupActionRows(brandId: string, campaignIds: readonly string[]): Promise<FollowupActionRow[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  const ids = [...new Set(campaignIds)];
  const out: FollowupActionRow[] = [];
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  for (let i = 0; i < ids.length; i += MAX_ACTING_CAMPAIGN_IDS) {
    const chunk = ids.slice(i, i + MAX_ACTING_CAMPAIGN_IDS);
    const response = await fetchWithRetry(
      `${url}/internal/brands/${encodeURIComponent(brandId)}/followup-actions?campaignIds=${chunk.map(encodeURIComponent).join(",")}`,
      { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
    );
    if (!response.ok) {
      throw new Error(`lead-service /internal/brands/:brandId/followup-actions failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as { leads?: unknown };
    if (!Array.isArray(data.leads)) throw new Error("lead-service /internal/brands/:brandId/followup-actions returned no leads array");
    for (const raw of data.leads as Array<Record<string, unknown>>) {
      const acting = str(raw.actingCampaignId);
      const leadId = str(raw.leadId);
      if (!acting || !leadId || typeof raw.actedCount !== "number" || typeof raw.claimCount !== "number") {
        throw new Error("lead-service /internal/brands/:brandId/followup-actions returned a malformed row");
      }
      out.push({ actingCampaignId: acting, leadId, firstClaimedAt: str(raw.firstClaimedAt), firstActedAt: str(raw.firstActedAt), actedCount: raw.actedCount, claimCount: raw.claimCount });
    }
  }
  return out;
}

/**
 * The served name of the LLM alias on a follow-up ledger row (lead-service, BEST-TPL-LLM-1022): the alias the row's LATEST
 * acted act stated it wrote with (null = no act stated one). One constant, so conforming to the producer is one line.
 */
export const LEDGER_LLM_ALIAS_FIELD = "latestLlmAlias";

/**
 * Which LLM wrote each person an acting campaign acted on (BEST-TPL-LLM-1022): `${actingCampaignId}|${leadId}` → the
 * alias the row's latest act stated. A row stating none is absent (its writer is not on record). Same ledger read as
 * `fetchFollowupActedLeads`. Fails loud.
 */
export async function fetchFollowupLlmAliases(brandId: string, campaignIds: readonly string[]): Promise<Map<string, string>> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  const ids = [...new Set(campaignIds)];
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += MAX_ACTING_CAMPAIGN_IDS) {
    const chunk = ids.slice(i, i + MAX_ACTING_CAMPAIGN_IDS);
    const response = await fetchWithRetry(
      `${url}/internal/brands/${encodeURIComponent(brandId)}/followup-actions?campaignIds=${chunk.map(encodeURIComponent).join(",")}`,
      { headers: { "x-api-key": apiKey, "x-service-name": "features-service" } },
    );
    if (!response.ok) throw new Error(`lead-service /internal/brands/:brandId/followup-actions failed (${response.status}): ${await response.text()}`);
    const data = (await response.json()) as { leads?: unknown };
    if (!Array.isArray(data.leads)) throw new Error("lead-service /internal/brands/:brandId/followup-actions returned no leads array");
    for (const raw of data.leads as Array<Record<string, unknown>>) {
      const alias = raw[LEDGER_LLM_ALIAS_FIELD];
      if (typeof raw.actingCampaignId === "string" && typeof raw.leadId === "string" && typeof alias === "string" && alias) out.set(`${raw.actingCampaignId}|${raw.leadId}`, alias);
    }
  }
  return out;
}
