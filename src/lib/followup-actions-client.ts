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
