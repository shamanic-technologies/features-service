/**
 * Fetch (org, brand, workflow) lead memberships for a feature from lead-service
 * GET /internal/feature-memberships.
 *
 * Drives the public cross-org revenue aggregation: features-service runs its revenue
 * engine once per (org, brand), forwarding the OWNING org's x-org-id to the existing
 * /orgs/* reads — so the public number is the same exact engine the dashboard runs.
 * This endpoint enumerates which (org, brand[, workflow]) combinations actually have
 * leads for the feature, so we know which orgs to forward.
 *
 * api-key only (no identity headers) — it's a cross-org internal read.
 * Fails loud on any transport / non-OK error.
 */
export interface FeatureMembership {
  orgId: string;
  brandId: string;
  workflowSlug: string;
}

export async function fetchFeatureMemberships(featureSlugs: string): Promise<FeatureMembership[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ featureSlugs });
  const response = await fetch(`${url}/internal/feature-memberships?${params}`, {
    headers: { "x-api-key": apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`lead-service /internal/feature-memberships failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { memberships: FeatureMembership[] };
  return data.memberships;
}
