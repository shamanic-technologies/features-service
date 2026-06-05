import type { EnginePerson } from "./revenue-engine.js";

/**
 * Shape of one leads_campaigns row returned by lead-service GET /orgs/leads.
 * Only the fields the revenue engine needs are typed; the row carries much more.
 */
interface LeadOrganization {
  id?: string | null;
  name?: string | null;
  logoUrl?: string | null;
}

interface LeadRow {
  leadId: string;
  email?: string | null;
  // Delivery-status overlay (brand- or campaign-scoped depending on the query params).
  contacted?: boolean;
  sent?: boolean;
  delivered?: boolean;
  clicked?: boolean;
  bounced?: boolean;
  unsubscribed?: boolean;
  replied?: boolean;
  replyClassification?: "positive" | "negative" | "neutral" | null;
  // Canonical lead payload.
  lead?: {
    firstName?: string | null;
    lastName?: string | null;
    photoUrl?: string | null;
    organization?: LeadOrganization | null;
  } | null;
}

/**
 * Fetch all leads for a brand (optionally one campaign) with delivery-status overlay,
 * mapped into engine persons. Fails loud on any transport / non-OK error — a swallowed
 * error would silently under-report pipeline.
 *
 * `signals`:
 *   - clicked        ← delivery overlay `clicked`
 *   - positiveReply  ← `replied && replyClassification === "positive"`
 */
export async function fetchLeadsForRevenue(
  brandId: string,
  campaignId: string | undefined,
  headers: { orgId: string; userId: string; runId: string; featureSlug?: string },
): Promise<EnginePerson[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }

  const params = new URLSearchParams({ brandId });
  if (campaignId) params.set("campaignId", campaignId);

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-user-id": headers.userId,
    "x-run-id": headers.runId,
    "x-brand-id": brandId,
  };
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetch(`${url}/orgs/leads?${params}`, { headers: reqHeaders });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`lead-service /orgs/leads failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { leads: LeadRow[] };
  return data.leads.map((row) => {
    const org = row.lead?.organization ?? null;
    // Bounced / unsubscribed leads are dead — no forward expected revenue at any stage.
    const dead = Boolean(row.bounced) || Boolean(row.unsubscribed);
    const signals = dead
      ? { contacted: false, sent: false, delivered: false, clicked: false, positiveReply: false }
      : {
          contacted: Boolean(row.contacted),
          sent: Boolean(row.sent),
          delivered: Boolean(row.delivered),
          clicked: Boolean(row.clicked),
          positiveReply: Boolean(row.replied) && row.replyClassification === "positive",
        };
    return {
      leadId: row.leadId,
      email: row.email ?? null,
      firstName: row.lead?.firstName ?? null,
      lastName: row.lead?.lastName ?? null,
      photoUrl: row.lead?.photoUrl ?? null,
      orgId: org?.id ?? null,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logoUrl ?? null,
      signals,
    };
  });
}
