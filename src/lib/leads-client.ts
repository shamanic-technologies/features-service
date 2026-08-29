import type { EnginePerson } from "./revenue-engine.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { campaignFamilySet, singleCampaignId, type CampaignFilter } from "./campaign-scope.js";

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
  /** The campaign the row was served under — the key a campaign family is filtered on. */
  campaignId?: string | null;
  /**
   * The WORKFLOW the row was served under, as lead-service froze it on the `leads_campaigns` row at
   * serve time. The producer owns this attribution — it is never inferred here from the campaign's
   * CURRENT workflow, which a campaign switches while keeping its id (so the campaign row's workflow
   * would mis-attribute every lead served before the switch).
   */
  workflowSlug?: string | null;
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
 * IN-FLIGHT reads of the SAME lead page, keyed by its exact request. NOT a cache — the entry is
 * dropped the moment the fetch settles, so nobody is ever served a stale page and the next read
 * goes to lead-service as before.
 *
 * It exists because this process runs with a 384 MB heap and a big brand's page is the largest
 * body it parses. Two surfaces legitimately want that same page at the same moment (the brand stat
 * card and the campaign breakdown both refresh in the background when the dashboard opens), and
 * two simultaneous parses of one page do not fit — the process was OOM-killed and restarted. One
 * fetch, one parse, both callers served: identical inputs cannot have different answers, so this
 * changes no number. Callers only READ these rows (each maps its own persons), so sharing is safe.
 */
const inFlightLeadPages = new Map<string, Promise<{ leads: LeadRow[] }>>();

async function sharedLeadPage(url: string, reqHeaders: Record<string, string>): Promise<{ leads: LeadRow[] }> {
  // The org is what scopes the answer; the rest of the identity headers are context, not filters.
  const key = `${reqHeaders["x-org-id"]}|${url}`;
  const existing = inFlightLeadPages.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const response = await fetchWithRetry(url, { headers: reqHeaders });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`lead-service /orgs/leads failed (${response.status}): ${text}`);
    }
    return (await response.json()) as { leads: LeadRow[] };
  })();

  inFlightLeadPages.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlightLeadPages.delete(key);
  }
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
  // One campaign, or the family sharing one identity (see campaign-identity.ts). lead-service takes
  // no campaign LIST, so a family reads the brand-wide page and keeps the rows whose `campaignId` is
  // a member. That is also the RIGHT delivery overlay for a family: brand-scoped status answers "did
  // this lead ever click for this brand", which is what one campaign's total means once its stopped
  // ancestors are folded in — and a lead served under two members is ONE lead, deduped downstream by
  // the engine's `dedupPersonsByLead` rather than counted twice.
  campaignScope: CampaignFilter,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<EnginePerson[]> {
  const campaignId = singleCampaignId(campaignScope);
  const family = campaignFamilySet(campaignScope);
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

  const data = await sharedLeadPage(`${url}/orgs/leads?${params}`, reqHeaders);
  const rows = family ? data.leads.filter((row) => row.campaignId && family.has(row.campaignId)) : data.leads;
  return rows.map((row) => {
    const org = row.lead?.organization ?? null;
    // A lead whose email BOUNCED, or who UNSUBSCRIBED, can never convert — no forward expected revenue
    // at any stage. That is a statement about its FUTURE, and it is expressed by zeroing the CONVERSION
    // legs alone.
    const dead = Boolean(row.bounced) || Boolean(row.unsubscribed);
    const signals: Record<string, boolean> = {
      // THE DELIVERY LADDER IS A SET OF FACTS ABOUT OUR OWN SENDING, AND A FACT IS NEVER ZEROED.
      // We queued the email, we sent it, we paid for it — a bounce is the PROOF a send happened, so
      // reading it as "never contacted" made the response contradict itself (40 bounced beside a
      // contacted figure that excluded those same 40) and moved the funnel's first-rung base. None of
      // these is a step of any funnel (they are `SALES_MILESTONES`, which carry no revenue field), so
      // stating them truthfully adds exactly zero expected value.
      contacted: Boolean(row.contacted),
      sent: Boolean(row.sent),
      delivered: Boolean(row.delivered),
      bounced: Boolean(row.bounced),
      unsubscribed: Boolean(row.unsubscribed),
      // THE CONVERSION LEGS ARE WHERE "CANNOT CONVERT" IS SAID, and they are the only thing the
      // dead flag touches — so the expected-value math is byte-unchanged by the ladder above.
      clicked: dead ? false : Boolean(row.clicked),
      positiveReply: dead ? false : Boolean(row.replied) && row.replyClassification === "positive",
      // The other two reply classes, on the SAME terms as the positive one — they are person-grain
      // counts the stats surfaces report, and only a per-lead basis can bound a campaign identity's
      // total by its brand's. No funnel path reads them, so the engine's EV is untouched.
      negativeReply: dead ? false : Boolean(row.replied) && row.replyClassification === "negative",
      neutralReply: dead ? false : Boolean(row.replied) && row.replyClassification === "neutral",
    };
    return {
      leadId: row.leadId,
      campaignId: row.campaignId ?? null,
      workflowSlug: row.workflowSlug ?? null,
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
