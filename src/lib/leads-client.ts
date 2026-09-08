import type { EnginePerson } from "./revenue-engine.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { createSlotLimiter } from "./concurrency.js";
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
 * HOW MUCH OF A BRAND'S POPULATION ONE REQUEST ASKS FOR.
 *
 * lead-service serves the whole set in ONE body when no `limit` is named, and a brand's set is
 * 50k-66k rows for the six largest — a multi-second, multi-megabyte read. Several of those in
 * flight at once is what took lead-service down on 2026-09-07: ten landed together, this service's
 * client gave up at its 300s headers timeout, and the backends behind those abandoned sockets stayed
 * pinned writing to nobody until the pool was gone.
 *
 * The producer states a total order over `(created_at, id)` and guarantees a `limit` + `cursor` walk
 * visits every row EXACTLY ONCE — no gaps, no repeats — so the walk below reads the SAME population
 * the unbounded read returned, in the same order. Nothing about what the aggregation computes moves;
 * only the shape of the asking does. What it buys: a page is short-lived, so ABANDONING one costs the
 * downstream one page's work rather than minutes of it, and a walk holds ONE connection at a time
 * instead of one for its whole duration.
 */
const LEAD_PAGE_SIZE = positiveIntEnv("LEAD_PAGE_SIZE", 5000);

/**
 * HOW MANY WHOLE-POPULATION READS THIS PROCESS WILL HAVE IN FLIGHT AT ONCE, ACROSS EVERY CALL SITE.
 *
 * `mapWithConcurrency` bounds ONE fan-out; it cannot bound the SUM of several running at the same
 * moment (the cross-org revenue roll-up, the customer-health board and a dashboard read are three
 * independent fan-outs that all read leads). lead-service's connection pool is a shared resource, so
 * the cap belongs at the boundary that consumes it — here — where no call site can opt out of it and
 * a new one inherits it for free. Sized BELOW what the downstream can absorb so its own live traffic
 * still has room; the incident took ten simultaneous reads.
 */
const LEAD_READ_CONCURRENCY = positiveIntEnv("LEAD_READ_CONCURRENCY", 4);

/**
 * How long one PAGE may take before the request is ABORTED. Aborting destroys the socket, so
 * lead-service learns immediately that nobody is reading and releases the backend behind it —
 * unlike undici's 300s headers timeout, which only makes us stop waiting. A page of
 * `LEAD_PAGE_SIZE` slim rows is normally sub-second, so this is a ceiling, not a budget.
 */
const LEAD_PAGE_TIMEOUT_MS = positiveIntEnv("LEAD_PAGE_TIMEOUT_MS", 60_000);

/**
 * A walk longer than this means the producer is not advancing and we would loop forever. Fail LOUD:
 * a truncated population would silently under-report every figure derived from it, which is worse
 * than a 502 that says the read did not complete.
 */
const MAX_LEAD_PAGES = 500;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

const leadReadSlots = createSlotLimiter(LEAD_READ_CONCURRENCY);

/** Test seam — how many lead-service page reads hold a slot right now. */
export function __leadReadsInFlight(): number {
  return leadReadSlots.inFlight;
}

interface LeadPage {
  leads: LeadRow[];
  nextCursor?: string | null;
}

/**
 * Walk the whole population one bounded page at a time, then hand back the complete set. Every page
 * goes through the process-wide slot limiter, so N concurrent walks still put at most
 * `LEAD_READ_CONCURRENCY` requests on lead-service at any instant.
 */
async function walkLeadPages(baseUrl: string, reqHeaders: Record<string, string>): Promise<LeadRow[]> {
  const rows: LeadRow[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_LEAD_PAGES) {
      throw new Error(
        `lead-service /orgs/leads walk exceeded ${MAX_LEAD_PAGES} pages for ${baseUrl} — refusing to report a truncated population`,
      );
    }

    const url = cursor === null ? baseUrl : `${baseUrl}&cursor=${encodeURIComponent(cursor)}`;
    const data = await leadReadSlots.run(async () => {
      const response = await fetchWithRetry(url, { headers: reqHeaders }, { timeoutMs: LEAD_PAGE_TIMEOUT_MS });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`lead-service /orgs/leads failed (${response.status}): ${text}`);
      }
      return (await response.json()) as LeadPage;
    });

    rows.push(...data.leads);

    const next = data.nextCursor ?? null;
    if (next === null) return rows;
    if (seenCursors.has(next)) {
      throw new Error(`lead-service /orgs/leads returned a repeating cursor for ${baseUrl} — refusing to loop`);
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/**
 * IN-FLIGHT walks of the SAME lead population, keyed by its exact request. NOT a cache — the entry is
 * dropped the moment the walk settles, so nobody is ever served a stale page and the next read
 * goes to lead-service as before.
 *
 * It exists because this process runs with a 384 MB heap and a big brand's population is the largest
 * thing it parses. Two surfaces legitimately want that same population at the same moment (the brand
 * stat card and the campaign breakdown both refresh in the background when the dashboard opens), and
 * two simultaneous walks of one brand do not fit — the process was OOM-killed and restarted. One
 * walk, one parse, both callers served: identical inputs cannot have different answers, so this
 * changes no number. Callers only READ these rows (each maps its own persons), so sharing is safe.
 */
const inFlightLeadPages = new Map<string, Promise<LeadRow[]>>();

async function sharedLeadPage(baseUrl: string, reqHeaders: Record<string, string>): Promise<LeadRow[]> {
  // The org is what scopes the answer; the rest of the identity headers are context, not filters.
  const key = `${reqHeaders["x-org-id"]}|${baseUrl}`;
  const existing = inFlightLeadPages.get(key);
  if (existing) return existing;

  const pending = walkLeadPages(baseUrl, reqHeaders);

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
  const params = new URLSearchParams({ brandId, view: "basic", limit: String(LEAD_PAGE_SIZE) });
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

  const allRows = await sharedLeadPage(`${url}/orgs/leads?${params}`, reqHeaders);
  const rows = family ? allRows.filter((row) => row.campaignId && family.has(row.campaignId)) : allRows;
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
