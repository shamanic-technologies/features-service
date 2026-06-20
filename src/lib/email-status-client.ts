/**
 * Fetch per-event engagement timestamps from email-gateway POST /orgs/status.
 *
 * email-gateway exposes first-occurrence (MIN) ISO timestamps per event type on each
 * StatusScope (firstClickedAt, firstRepliedAt, ...) across two providers (broadcast /
 * transactional). We read the scope matching the query (brand scope when only brandId,
 * campaign scope when campaignId) and merge the two providers by taking the earliest
 * non-null timestamp per event type.
 *
 * Returns a map email → funnel-signal dates ({ clicked, positiveReply }). Fails loud on
 * any transport / non-OK error — the caller decides whether to degrade (these timestamps
 * are a secondary enrichment; the pipeline total does not depend on them).
 */

import { fetchWithRetry } from "./fetch-retry.js";

interface StatusScope {
  firstContactedAt?: string | null;
  firstSentAt?: string | null;
  firstDeliveredAt?: string | null;
  firstClickedAt?: string | null;
  firstRepliedAt?: string | null;
  firstOpenedAt?: string | null;
}

interface ProviderStatus {
  campaign?: StatusScope | null;
  brand?: StatusScope | null;
}

interface StatusResult {
  email: string;
  broadcast?: ProviderStatus;
  transactional?: ProviderStatus;
}

export interface SignalDates {
  contacted: string | null;
  sent: string | null;
  delivered: string | null;
  open: string | null;
  clicked: string | null;
  positiveReply: string | null;
}

/** Boolean/classification fields on a StatusScope (distinct from the first*At timestamps). */
interface OutcomeScope {
  contacted?: boolean;
  opened?: boolean;
  clicked?: boolean;
  replied?: boolean;
  replyClassification?: "positive" | "negative" | "neutral" | null;
}

export interface EmailOutcome {
  contacted: boolean;
  opened: boolean;
  clicked: boolean;
  positiveReply: boolean;
}

/**
 * Per-email brand-scoped outcome flags from email-gateway POST /orgs/status.
 * Reads the broadcast `brand` scope booleans (contacted / opened / clicked) + positive-reply
 * (replied AND replyClassification === "positive"). Used to aggregate outcomes per audience
 * after resolving email->audience membership from human-service. Fails loud on transport /
 * non-OK error.
 */
export async function fetchEmailOutcomes(
  brandId: string,
  emails: string[],
  headers: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
): Promise<Map<string, EmailOutcome>> {
  const result = new Map<string, EmailOutcome>();
  if (emails.length === 0) return result;

  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (headers.campaignId) reqHeaders["x-campaign-id"] = headers.campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  const response = await fetchWithRetry(`${url}/orgs/status`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify({ brandId, items: emails.map((email) => ({ email })) }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/status failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    results: Array<{ email: string; broadcast?: { brand?: OutcomeScope | null } }>;
  };
  for (const item of data.results) {
    const brand = item.broadcast?.brand ?? null;
    result.set(item.email, {
      contacted: Boolean(brand?.contacted),
      opened: Boolean(brand?.opened),
      clicked: Boolean(brand?.clicked),
      positiveReply: Boolean(brand?.replied) && brand?.replyClassification === "positive",
    });
  }
  return result;
}

const minDate = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
};

function scopeFor(provider: ProviderStatus | undefined, campaignScoped: boolean): StatusScope | null {
  if (!provider) return null;
  return (campaignScoped ? provider.campaign : provider.brand) ?? null;
}

export async function fetchEventTimestamps(
  brandId: string,
  campaignId: string | undefined,
  emails: string[],
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<Map<string, SignalDates>> {
  const result = new Map<string, SignalDates>();
  if (emails.length === 0) return result;

  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  if (campaignId) reqHeaders["x-campaign-id"] = campaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  // Filtering is driven by body fields (campaignId takes precedence over brandId).
  const body: Record<string, unknown> = { items: emails.map((email) => ({ email })) };
  if (campaignId) body.campaignId = campaignId;
  else body.brandId = brandId;

  const response = await fetchWithRetry(`${url}/orgs/status`, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/status failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { results: StatusResult[] };
  const campaignScoped = Boolean(campaignId);

  for (const item of data.results) {
    const broadcast = scopeFor(item.broadcast, campaignScoped);
    const transactional = scopeFor(item.transactional, campaignScoped);
    result.set(item.email, {
      contacted: minDate(broadcast?.firstContactedAt ?? null, transactional?.firstContactedAt ?? null),
      sent: minDate(broadcast?.firstSentAt ?? null, transactional?.firstSentAt ?? null),
      delivered: minDate(broadcast?.firstDeliveredAt ?? null, transactional?.firstDeliveredAt ?? null),
      open: minDate(broadcast?.firstOpenedAt ?? null, transactional?.firstOpenedAt ?? null),
      clicked: minDate(broadcast?.firstClickedAt ?? null, transactional?.firstClickedAt ?? null),
      positiveReply: minDate(broadcast?.firstRepliedAt ?? null, transactional?.firstRepliedAt ?? null),
    });
  }

  return result;
}
