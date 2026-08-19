/**
 * Read a brand's campaigns from campaign-service — the OWNER of a campaign's identity — and group
 * them into families. campaign-service stores all four parts of the identity on every row since its
 * migration 0044; nothing is re-derived here (see campaign-identity.ts).
 *
 * FAIL-SOFT, with a loud log. The families decide how per-campaign figures are TOTALLED, not what
 * any of them is: with campaign-service unreachable every campaign falls back to its own family of
 * one, which is exactly the behaviour these surfaces had before this feature. That degrades the
 * grouping (the customer sees one line per stopped row again for as long as the outage lasts) and
 * never a number — the opposite of the fail-loud rule's target, which is a fabricated figure.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import {
  buildCampaignFamilies,
  EMPTY_CAMPAIGN_FAMILIES,
  type CampaignFamilies,
  type CampaignIdentityRow,
} from "./campaign-identity.js";

/**
 * The brand's campaign ROWS as campaign-service serves them, before any grouping.
 *
 * Extracted so the two grains built on the campaign row — the campaign IDENTITY families below, and
 * the OFFER partition in `offer-scope.ts` — issue the byte-same read instead of drifting into two
 * spellings of one question. FAIL-LOUD; each caller wraps it with the posture its own answer needs
 * (soft for the families, loud for the offer partition — see each module's doc for why).
 */
export async function fetchBrandCampaignRows(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<CampaignIdentityRow[]> {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  }

  // brandId filters on the legacy `brand_ids` array server-side, which is what every historical row
  // still carries; featureSlug narrows to the feature whose campaigns are being totalled.
  const params = new URLSearchParams({ brandId, featureSlug });
  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;

  const response = await fetchWithRetry(`${url}/campaigns?${params}`, { headers: reqHeaders });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] campaign-service /campaigns failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { campaigns?: CampaignIdentityRow[] };
  if (!Array.isArray(data.campaigns)) {
    throw new Error("[features-service] campaign-service /campaigns returned no campaigns array");
  }
  return data.campaigns;
}

export async function fetchCampaignFamilies(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<CampaignFamilies> {
  return buildCampaignFamilies(await fetchBrandCampaignRows(brandId, featureSlug, headers));
}

/** The fail-soft wrapper every stats surface uses. See the module doc for why it degrades. */
export async function fetchCampaignFamiliesSoft(
  brandId: string,
  featureSlug: string,
  headers: { orgId: string; userId?: string; runId?: string },
): Promise<CampaignFamilies> {
  try {
    return await fetchCampaignFamilies(brandId, featureSlug, headers);
  } catch (error) {
    console.warn(
      `[features-service] campaign identity unavailable (per-campaign totals stay ungrouped): ${(error as Error).message}`,
    );
    return EMPTY_CAMPAIGN_FAMILIES;
  }
}
