import type { EnginePerson } from "./revenue-engine.js";
import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Shape of one leads_campaigns row returned by lead-service GET /orgs/leads.
 * Only the fields the revenue engine needs are typed; the row carries much more.
 */
interface LeadOrganization {
  id?: string | null;
  name?: string | null;
  logoUrl?: string | null;
  /** Bare company domain (no protocol), e.g. "cascobay.com". */
  primaryDomain?: string | null;
  /** Canonical company website URL (with protocol), e.g. "https://cascobay.com". */
  websiteUrl?: string | null;
  // Firmographic passthrough (lead-service #327) — carried onto the revenue leads[] row so the
  // digest / dashboard can show WHO the prospect's company is. Null when the upstream enrichment
  // never resolved a value; never synthesized.
  industry?: string | null;
  /** Apollo estimated headcount (raw number — the consumer bands it for display). */
  estimatedNumEmployees?: number | null;
  city?: string | null;
  country?: string | null;
}

/**
 * Bare hostname (no protocol, no leading "www.", no path) from a website URL — the shape
 * logo.dev expects. Returns null for empty / malformed input: a missing or unparseable URL
 * means "domain unknown" (the documented orgDomain=null case), not an error to surface.
 */
function domainFromUrl(websiteUrl: string | null | undefined): string | null {
  if (!websiteUrl) return null;
  try {
    const host = new URL(websiteUrl).hostname.replace(/^www\./i, "");
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
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
    // Firmographic passthrough (lead-service #327/#336) — the person's current-employer job title
    // + Apollo seniority band. Null when unknown; never synthesized.
    currentTitle?: string | null;
    seniority?: string | null;
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
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<EnginePerson[]> {
  const url = process.env.LEAD_SERVICE_URL;
  const apiKey = process.env.LEAD_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("LEAD_SERVICE_URL or LEAD_SERVICE_API_KEY not configured");
  }

  // view=basic asks lead-service for the slim lead projection (#273/#281): same envelope
  // and delivery-status overlay, but each row's nested `lead` is trimmed to the handful of
  // thin fields the revenue engine reads. Cuts a ~150 MB body ~10x for big brands, removing
  // the `await response.json()` heap-OOM behind "Failed to compute feature revenue".
  const params = new URLSearchParams({ brandId, view: "basic" });
  if (campaignId) params.set("campaignId", campaignId);

  const reqHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/orgs/leads?${params}`, { headers: reqHeaders });

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
      // Prefer the bare primaryDomain; fall back to a hostname parsed from websiteUrl. Null when neither known.
      orgDomain: org?.primaryDomain ?? domainFromUrl(org?.websiteUrl),
      // Firmographic passthrough — null when the upstream enrichment never resolved a value (no synthesis).
      title: row.lead?.currentTitle ?? null,
      seniority: row.lead?.seniority ?? null,
      orgIndustry: org?.industry ?? null,
      orgEmployeeCount: org?.estimatedNumEmployees ?? null,
      orgCity: org?.city ?? null,
      orgCountry: org?.country ?? null,
      signals,
    };
  });
}
