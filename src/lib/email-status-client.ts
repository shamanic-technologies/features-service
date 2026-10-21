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
import { gatewayAcceptedEmails } from "./gateway-email.js";
import { emailFingerprints, fingerprintScopeKey, liveLeadCopyRequested } from "./lead-copy.js";

interface StatusScope {
  /** MAX timestamp of the provider's per-step `email_sent` event in this scope (instantly-service). */
  lastDeliveredAt?: string | null;
  firstContactedAt?: string | null;
  firstSentAt?: string | null;
  firstBouncedAt?: string | null;
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
  /**
   * The LAST email actually SENT to this person — the provider's per-step `email_sent` event, MAX over
   * every step (email-gateway's `lastDeliveredAt`, which instantly-service computes as
   * `MAX(timestamp) FILTER (event_type = 'email_sent')`). Not the contacted date and not the first
   * send: it is what a contacted lead's expiry is counted from (lib/revenue-engine.ts).
   */
  lastSent: string | null;
}

/** Boolean/classification fields on a StatusScope (distinct from the first*At timestamps). */
interface OutcomeScope {
  contacted?: boolean;
  sent?: boolean;
  bounced?: boolean;
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
 * Per-email outcome flags from email-gateway POST /orgs/status.
 *
 * Reads the broadcast outcome-scope booleans (contacted / opened / clicked) + positive-reply
 * (replied AND replyClassification === "positive"). Used to aggregate outcomes per audience
 * after resolving email->audience membership from human-service. Fails loud on transport /
 * non-OK error.
 *
 * Scope is driven by BODY fields (email-gateway ignores identity headers for filtering):
 * - BRAND scope (default, `scopeCampaignId` omitted): body sends `brandId`, response carries
 *   `broadcast.brand` (BOOL_OR across the brand's campaigns). Byte-identical to the historical
 *   brand-wide behavior for every existing caller.
 * - CAMPAIGN scope (`scopeCampaignId` present): body sends `campaignId` (email-gateway campaign
 *   mode takes precedence over brandId), response carries `broadcast.campaign` — the outcome
 *   flags scoped to that single campaign. Powers the dashboard's per-campaign audience view.
 */
export async function fetchEmailOutcomes(
  brandId: string,
  emails: string[],
  headers: { orgId: string; userId?: string; runId?: string; campaignId?: string; featureSlug?: string },
  scopeCampaignId?: string,
): Promise<Map<string, EmailOutcome>> {
  const result = new Map<string, EmailOutcome>();
  if (emails.length === 0) return result;

  const url = process.env.EMAIL_GATEWAY_SERVICE_URL;
  const apiKey = process.env.EMAIL_GATEWAY_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("EMAIL_GATEWAY_SERVICE_URL or EMAIL_GATEWAY_SERVICE_API_KEY not configured");
  }

  const campaignScoped = Boolean(scopeCampaignId);
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": headers.orgId,
    "x-brand-id": brandId,
  };
  if (headers.userId) reqHeaders["x-user-id"] = headers.userId;
  if (headers.runId) reqHeaders["x-run-id"] = headers.runId;
  // Tracing header follows the actual scope: the campaign under stats when campaign-scoped,
  // else the inbound identity campaign (email-gateway ignores it for filtering either way).
  const traceCampaignId = scopeCampaignId ?? headers.campaignId;
  if (traceCampaignId) reqHeaders["x-campaign-id"] = traceCampaignId;
  if (headers.featureSlug) reqHeaders["x-feature-slug"] = headers.featureSlug;

  // Filtering is driven by body fields (campaignId takes precedence over brandId, per the
  // email-gateway /orgs/status contract). Campaign scope → send campaignId; else send brandId.
  // Only addresses email-gateway accepts: one it refuses fails the whole batch (lib/gateway-email.ts).
  const asked = gatewayAcceptedEmails(emails, `email outcomes (brand ${brandId})`);
  if (asked.length === 0) return result;
  const body: Record<string, unknown> = { items: asked.map((email) => ({ email })) };
  if (campaignScoped) body.campaignId = scopeCampaignId;
  else body.brandId = brandId;

  // Audience-forecast input (pipeline-activity): an audience's members' outcome flags move slowly, so
  // an interactive view reuses the answer for 30s, re-read behind it (fetch-retry.ts `shareForMs`).
  const response = await fetchWithRetry(
    `${url}/orgs/status`,
    { method: "POST", headers: reqHeaders, body: JSON.stringify(body) },
    { shareForMs: 30_000 },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`email-gateway /orgs/status failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    results: Array<{ email: string; broadcast?: { brand?: OutcomeScope | null; campaign?: OutcomeScope | null } }>;
  };
  for (const item of data.results) {
    const scope = (campaignScoped ? item.broadcast?.campaign : item.broadcast?.brand) ?? null;
    result.set(item.email, {
      // Contacted = an email went out (`sent`, or a send that `bounced`), never the queue push (`contacted`), owner 2026-10-12.
      contacted: Boolean(scope?.sent) || Boolean(scope?.bounced),
      opened: Boolean(scope?.opened),
      clicked: Boolean(scope?.clicked),
      positiveReply: Boolean(scope?.replied) && scope?.replyClassification === "positive",
    });
  }
  return result;
}

const minDate = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
};

const maxDate = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
};

function scopeFor(provider: ProviderStatus | undefined, campaignScoped: boolean): StatusScope | null {
  if (!provider) return null;
  return (campaignScoped ? provider.campaign : provider.brand) ?? null;
}

/**
 * INCREMENTAL timestamps for an interactive view (features-service#1045).
 *
 * A first-occurrence timestamp only moves when its delivery flag flips, and the live lead copy
 * (lead-copy.ts) fingerprints every email's flags. So inside a live-copy read, an email is asked
 * again only when its fingerprint changed since it was last asked (or it was never asked) — a
 * refresh of the busiest campaign asks tens of emails instead of ~18k. Every
 * {@link TIMESTAMP_FULL_REFRESH_MS} the whole set is asked again regardless, which bounds any
 * drift the flags cannot see (an out-of-order event moving a MIN earlier) to that window.
 * Outside a live-copy read nothing changes: every email is asked, as before.
 */
const TIMESTAMP_FULL_REFRESH_MS = 10 * 60_000;

interface TimestampCache {
  byEmail: Map<string, { fingerprint: string; dates: SignalDates | null }>;
  fullAt: number;
  lastReadAt: number;
}

const timestampCaches = new Map<string, TimestampCache>();

/** Test seam. */
export function __resetTimestampCaches(): void {
  timestampCaches.clear();
}

export async function fetchEventTimestamps(
  brandId: string,
  campaignId: string | undefined,
  emails: string[],
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<Map<string, SignalDates>> {
  if (emails.length === 0) return new Map();
  const scopeKey = fingerprintScopeKey(headers.orgId, brandId, campaignId);
  const fps = liveLeadCopyRequested() ? emailFingerprints(scopeKey) : undefined;
  if (!fps) return fetchEventTimestampsFor(brandId, campaignId, emails, headers);

  const now = Date.now();
  let cache = timestampCaches.get(scopeKey);
  if (!cache || now - cache.fullAt > TIMESTAMP_FULL_REFRESH_MS) {
    cache = { byEmail: new Map(), fullAt: now, lastReadAt: now };
  }
  const ask = emails.filter((email) => {
    const cached = cache!.byEmail.get(email);
    const fp = fps.get(email);
    return !cached || fp === undefined || cached.fingerprint !== fp;
  });
  if (ask.length > 0) {
    const fresh = await fetchEventTimestampsFor(brandId, campaignId, ask, headers);
    for (const email of ask) {
      cache.byEmail.set(email, { fingerprint: fps.get(email) ?? "", dates: fresh.get(email) ?? null });
    }
  }
  cache.lastReadAt = now;
  timestampCaches.delete(scopeKey);
  timestampCaches.set(scopeKey, cache);
  for (const [key, c] of timestampCaches) {
    if (timestampCaches.size <= 64 && now - c.lastReadAt <= TIMESTAMP_FULL_REFRESH_MS) break;
    if (key !== scopeKey) timestampCaches.delete(key);
  }

  // The same map a full ask returns: only emails the producer answered for.
  const result = new Map<string, SignalDates>();
  for (const email of emails) {
    const dates = cache.byEmail.get(email)?.dates;
    if (dates) result.set(email, dates);
  }
  return result;
}

/**
 * ONE SEND-DATE READ PER SCOPE (2026-10-21). email-gateway answers `/orgs/status` by proxying to instantly-service
 * with a 10 s timeout and one retry; instantly-service dedupes and caches (60 s) an answer keyed on the EXACT sorted
 * address list, and a cold answer for the biggest brand (f4d73dab, 10,401 addresses) took ~16 s under load (0.5 s
 * warm). One board + revenue read fired THREE brand-wide asks within 10 ms, on two different address lists (9,188
 * and 10,401), so instantly ran heavy aggregations side by side and every ask hit the gateway's timeout twice (502
 * at ~21 s): 3 of 6-8 calls failed on each replay. A call's fixed cost dominates (1,000 addresses ~1.8 s), so
 * chunking would only add calls.
 *
 * So the asks of one (org, brand, campaign) scope arriving within `SEND_DATES_BATCH_MS` are merged into ONE ask
 * of their union, asks of a scope never overlap (serialised), and an answer is remembered `SEND_DATES_MEMORY_MS`
 * (60 s, the producer's own cache window): a later ask only asks for addresses nobody asked yet. A failed ask
 * remembers nothing and fails every caller it carried; the next ask asks again. Bounded:
 * `SEND_DATES_MEMORY_SCOPES` scopes, oldest dropped first.
 */
const SEND_DATES_MEMORY_SCOPES = 8;
const envMs = (name: string, fallback: number): number => {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};
interface SendDatesMemory {
  at: number;
  asked: Set<string>;
  dates: Map<string, SignalDates>;
}
interface PendingSendDatesAsk {
  emails: Set<string>;
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string };
  waiters: Array<{ resolve: (m: SendDatesMemory) => void; reject: (e: unknown) => void }>;
}
const sendDatesMemory = new Map<string, SendDatesMemory>();
const sendDatesPending = new Map<string, PendingSendDatesAsk>();
const sendDatesQueue = new Map<string, Promise<unknown>>();

/** Test seam: forget every remembered send-date answer. */
export function __resetSendDatesMemory(): void {
  sendDatesMemory.clear();
  sendDatesPending.clear();
  sendDatesQueue.clear();
}

function freshMemory(key: string): SendDatesMemory | null {
  const m = sendDatesMemory.get(key);
  return m && Date.now() - m.at <= envMs("SEND_DATES_MEMORY_MS", 60_000) ? m : null;
}

async function flushSendDates(key: string, brandId: string, campaignId: string | undefined, batch: PendingSendDatesAsk): Promise<void> {
  try {
    const ttl = envMs("SEND_DATES_MEMORY_MS", 60_000);
    const memory = freshMemory(key) ?? { at: Date.now(), asked: new Set<string>(), dates: new Map<string, SignalDates>() };
    const missing = [...batch.emails].filter((e) => !memory.asked.has(e));
    if (missing.length > 0) {
      const fresh = await askEventTimestamps(brandId, campaignId, missing, batch.headers);
      if (memory.asked.size === 0) memory.at = Date.now();
      for (const e of missing) memory.asked.add(e);
      for (const [e, d] of fresh) memory.dates.set(e, d);
      if (ttl > 0) {
        sendDatesMemory.delete(key);
        sendDatesMemory.set(key, memory);
        for (const [k, m] of sendDatesMemory) {
          if (sendDatesMemory.size <= SEND_DATES_MEMORY_SCOPES && Date.now() - m.at <= ttl) break;
          if (k !== key) sendDatesMemory.delete(k);
        }
      }
    }
    for (const w of batch.waiters) w.resolve(memory);
  } catch (err) {
    for (const w of batch.waiters) w.reject(err);
  }
}

async function fetchEventTimestampsFor(
  brandId: string,
  campaignId: string | undefined,
  emails: string[],
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<Map<string, SignalDates>> {
  if (emails.length === 0) return new Map();
  const key = `${headers.orgId}|${brandId}|${campaignId ?? ""}`;
  const pick = (memory: SendDatesMemory): Map<string, SignalDates> => {
    const result = new Map<string, SignalDates>();
    for (const e of emails) {
      const d = memory.dates.get(e);
      if (d) result.set(e, d);
    }
    return result;
  };
  const known = freshMemory(key);
  if (known && emails.every((e) => known.asked.has(e))) return pick(known);

  let batch = sendDatesPending.get(key);
  if (!batch) {
    const created: PendingSendDatesAsk = { emails: new Set(), headers, waiters: [] };
    batch = created;
    sendDatesPending.set(key, created);
    setTimeout(() => {
      if (sendDatesPending.get(key) === created) sendDatesPending.delete(key);
      // Serialised per scope: this union is asked once the previous ask of the scope settled.
      const run = (sendDatesQueue.get(key) ?? Promise.resolve()).then(() => flushSendDates(key, brandId, campaignId, created));
      sendDatesQueue.set(key, run);
      void run.then(() => {
        if (sendDatesQueue.get(key) === run) sendDatesQueue.delete(key);
      });
    }, envMs("SEND_DATES_BATCH_MS", 50));
  }
  for (const e of emails) batch.emails.add(e);
  const memory = await new Promise<SendDatesMemory>((resolve, reject) => batch!.waiters.push({ resolve, reject }));
  return pick(memory);
}

async function askEventTimestamps(
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
  // Only addresses email-gateway accepts: one it refuses fails the whole batch (lib/gateway-email.ts).
  const asked = gatewayAcceptedEmails(emails, `event timestamps (brand ${brandId})`);
  if (asked.length === 0) return result;
  const body: Record<string, unknown> = { items: asked.map((email) => ({ email })) };
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
      // Contacted = the first email that went out (owner 2026-10-12): its send, or its bounce (a send
      // attempt that bounced was emailed), never the queue push (`firstContactedAt`).
      contacted: minDate(
        minDate(broadcast?.firstSentAt ?? null, transactional?.firstSentAt ?? null),
        minDate(broadcast?.firstBouncedAt ?? null, transactional?.firstBouncedAt ?? null),
      ),
      sent: minDate(broadcast?.firstSentAt ?? null, transactional?.firstSentAt ?? null),
      delivered: minDate(broadcast?.firstDeliveredAt ?? null, transactional?.firstDeliveredAt ?? null),
      open: minDate(broadcast?.firstOpenedAt ?? null, transactional?.firstOpenedAt ?? null),
      clicked: minDate(broadcast?.firstClickedAt ?? null, transactional?.firstClickedAt ?? null),
      positiveReply: minDate(broadcast?.firstRepliedAt ?? null, transactional?.firstRepliedAt ?? null),
      lastSent: maxDate(broadcast?.lastDeliveredAt ?? null, transactional?.lastDeliveredAt ?? null),
    });
  }

  return result;
}
