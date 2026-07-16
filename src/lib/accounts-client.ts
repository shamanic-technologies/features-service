/**
 * Cross-org (fleet-wide) reads that feed the staff-gated `GET /internal/stats/accounts` audit.
 *
 * Four producer reads, all api-key service-to-service:
 *   - org spendable balance      → billing-service  GET /internal/accounts/by-org/:orgId/balance  (api-key only, org in path)
 *   - brand pause state          → campaign-service GET /brands/:brandId/pause  (api-key + x-org-id)
 *   - org Clerk id + owner email → client-service   GET /internal/orgs/:orgId + GET /internal/users
 *   - brand name + domain        → brand-service    GET /internal/brands?ids=  (batch, ≤100/req)
 *
 * All are org-less platform reads: they authenticate with ONLY the service api-key and pass the org
 * as a PATH/QUERY param — NO forwarded/faked x-user-id identity (the balance read used to hit the
 * org-scoped `/v1/accounts/balance`, which required a user, forcing a sentinel UUID; it now uses
 * billing's user-less `/internal/accounts/by-org/:orgId/balance`).
 *
 * Fail loud on any transport / non-OK error (these own the displayed money + active determination —
 * not optional enrichment). The ONE mapped status is billing 404 "billing account not found" → zero
 * balances / no auto-topup: an org that never funded a wallet has zero credit, which is the correct
 * financial reading for the active rule (inactive). That is a documented billing semantic (see
 * api-registry), not a swallowed error.
 */
import { fetchWithRetry } from "./fetch-retry.js";

const BRAND_BATCH_CAP = 100;

export interface OrgIdentity {
  /** Clerk org id (org_...), for the admin to resolve the display name. null if unset on the org row. */
  orgExternalId: string | null;
  /** The org owner's email (earliest-created user of the org). null if the org has no users. */
  ownerEmail: string | null;
}

export interface BrandBasic {
  name: string | null;
  domain: string | null;
}

export interface OrgBalance {
  /** Spendable funds in USD (balance_cents/100 — credited minus committed usage, incl. provisioned holds). */
  spendableUsd: number;
  /**
   * ACTUAL credit balance in USD (actual_balance_cents/100 — credited minus ACTUALIZED usage only,
   * provisioned holds NOT subtracted). This is the figure the ACTIVE verdict gates on: an in-flight
   * provisioned hold is active spend, so subtracting it (spendable) wrongly reads a busy account "inactive".
   */
  actualUsd: number;
  /**
   * Whether the org has auto-topup enabled (billing `has_auto_topup` on this balance read — verified
   * live via api-registry: the deployed key is `has_auto_topup`, the SAME name `/v1/accounts` uses).
   * An auto-topup org never runs dry (it tops up on dip), so it is ACTIVE regardless of the momentary
   * balance. OPTIONAL — ABSENT ⇒ treated as not-enabled (fail-open to the actual-balance path, which
   * already corrects the verdict).
   */
  autoTopupEnabled: boolean;
}

function billingConfig(): { url: string; apiKey: string } {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

function clientConfig(): { url: string; apiKey: string } {
  const url = process.env.CLIENT_SERVICE_URL;
  const apiKey = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] CLIENT_SERVICE_URL or CLIENT_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

function brandConfig(): { url: string; apiKey: string } {
  const url = process.env.BRAND_SERVICE_URL;
  const apiKey = process.env.BRAND_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] BRAND_SERVICE_URL or BRAND_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

function campaignConfig(): { url: string; apiKey: string } {
  const url = process.env.CAMPAIGN_SERVICE_URL;
  const apiKey = process.env.CAMPAIGN_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] CAMPAIGN_SERVICE_URL or CAMPAIGN_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

/**
 * Whether a brand is PAUSED, from campaign-service `GET /brands/:brandId/pause` → `{ paused }`.
 * The brand active/paused status lives in campaign-service (NOT brand/billing): a brand can be paused
 * while keeping a non-zero daily budget (campaigns are HELD, not stopped). Pause is keyed by
 * (org, brand), so the owning org's x-org-id is required (api-key + x-org-id only — no user/run).
 * No pause row → `paused:false` (active by default). Fail loud on any non-OK.
 */
export async function fetchBrandPaused(brandId: string, orgId: string): Promise<boolean> {
  const { url, apiKey } = campaignConfig();
  const response = await fetchWithRetry(`${url}/brands/${encodeURIComponent(brandId)}/pause`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] campaign-service /brands/:brandId/pause failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { paused?: boolean };
  return data.paused === true;
}

/**
 * Org balance snapshot for the active verdict, from billing-service
 * `GET /internal/accounts/by-org/:orgId/balance` (user-less internal read — api-key only, org in path).
 * Reads `balance_cents` (spendable, display), `actual_balance_cents` (credited − ACTUALIZED usage; the
 * active-verdict figure), and the OPTIONAL `has_auto_topup` (absent ⇒ false). 404 (no billing
 * account) → zero balances / no auto-topup (see module doc).
 */
export async function fetchOrgBalance(orgId: string): Promise<OrgBalance> {
  const { url, apiKey } = billingConfig();
  const response = await fetchWithRetry(`${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}/balance`, {
    headers: { "x-api-key": apiKey },
  });

  if (response.status === 404) return { spendableUsd: 0, actualUsd: 0, autoTopupEnabled: false };
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] billing-service /internal/accounts/by-org/:orgId/balance failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    balance_cents?: string | number;
    actual_balance_cents?: string | number;
    has_auto_topup?: boolean;
  };
  const spendableCents = Number(data.balance_cents);
  if (!Number.isFinite(spendableCents)) {
    throw new Error(`[features-service] billing-service balance returned non-numeric balance_cents: ${JSON.stringify(data.balance_cents)}`);
  }
  const actualCents = Number(data.actual_balance_cents);
  if (!Number.isFinite(actualCents)) {
    throw new Error(`[features-service] billing-service balance returned non-numeric actual_balance_cents: ${JSON.stringify(data.actual_balance_cents)}`);
  }
  // has_auto_topup is OPTIONAL (older billing deploys omit it) — absent ⇒ not-enabled.
  return { spendableUsd: spendableCents / 100, actualUsd: actualCents / 100, autoTopupEnabled: data.has_auto_topup === true };
}

/**
 * The org's platform-usage discount percentage (0..100), from billing-service
 * `GET /internal/accounts/by-org/:orgId/usage-discount` → `{ discount_percent }` (user-less internal
 * read — api-key only, org in path). Billing OWNS the per-org usage discount; features-service reads it
 * and NEVER computes/derives it. A known org with NO discount returns `discount_percent = 0` (billing
 * contract). An org with no billing account (404) has no discount → 0 (same documented-not-found→neutral
 * mapping as the balance 404→0; a 502 here would 500 the whole fleet audit on one unfunded org). Any
 * OTHER non-OK fails loud.
 */
export async function fetchOrgUsageDiscountPct(orgId: string): Promise<number> {
  const { url, apiKey } = billingConfig();
  const response = await fetchWithRetry(`${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}/usage-discount`, {
    headers: { "x-api-key": apiKey },
  });

  if (response.status === 404) return 0; // no billing account ⇒ no discount (neutral)
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] billing-service /internal/accounts/by-org/:orgId/usage-discount failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { discount_percent?: number };
  const pct = Number(data.discount_percent);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error(`[features-service] billing-service usage-discount returned invalid discount_percent: ${JSON.stringify(data.discount_percent)}`);
  }
  return pct;
}

/**
 * Org Clerk external id + owner email. Two client-service reads:
 *   - GET /internal/orgs/:orgId          → { id, externalId, name }  (the org record)
 *   - GET /internal/users?orgId=&limit=  → owner = earliest-created user's email
 */
export async function fetchOrgIdentity(orgId: string): Promise<OrgIdentity> {
  const { url, apiKey } = clientConfig();
  const headers = { "x-api-key": apiKey };

  const [orgRes, usersRes] = await Promise.all([
    fetchWithRetry(`${url}/internal/orgs/${encodeURIComponent(orgId)}`, { headers }),
    fetchWithRetry(`${url}/internal/users?orgId=${encodeURIComponent(orgId)}&limit=100`, { headers }),
  ]);

  // A feature-membership org may have no client-service row (org resolved directly in lead/billing,
  // or staging data drift). 404 "not found" ⇒ its Clerk identity is simply unknown → null, and the
  // account row is STILL listed. That's the truthful null (both fields are nullable by contract), not
  // a swallowed error — same documented-not-found→null mapping as billing balance 404→0. Any OTHER
  // non-OK fails loud.
  let orgExternalId: string | null = null;
  if (orgRes.status !== 404) {
    if (!orgRes.ok) {
      const body = await orgRes.text();
      throw new Error(`[features-service] client-service /internal/orgs/:orgId failed (${orgRes.status}): ${body}`);
    }
    const org = (await orgRes.json()) as { externalId?: string | null };
    orgExternalId = org.externalId ?? null;
  }

  let ownerEmail: string | null = null;
  if (usersRes.status !== 404) {
    if (!usersRes.ok) {
      const body = await usersRes.text();
      throw new Error(`[features-service] client-service /internal/users failed (${usersRes.status}): ${body}`);
    }
    const usersData = (await usersRes.json()) as {
      users?: Array<{ email?: string | null; createdAt?: string }>;
    };
    if (!Array.isArray(usersData.users)) {
      throw new Error("[features-service] client-service /internal/users returned no users array");
    }
    // Owner = earliest-created user of the org (proxy for the founding owner).
    const sorted = [...usersData.users].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    ownerEmail = sorted.find((u) => typeof u.email === "string" && u.email.length > 0)?.email ?? null;
  }

  return { orgExternalId, ownerEmail };
}

/**
 * Batch-resolve brand name + domain by ids, from brand-service `GET /internal/brands?ids=`.
 * Chunked at the 100-id cap. Missing ids are silently omitted by brand-service; the caller maps by id
 * (an absent brand yields no map entry → row renders null name/domain, still listed).
 */
export async function fetchBrandsBasic(ids: string[]): Promise<Map<string, BrandBasic>> {
  const out = new Map<string, BrandBasic>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const { url, apiKey } = brandConfig();
  for (let i = 0; i < unique.length; i += BRAND_BATCH_CAP) {
    const chunk = unique.slice(i, i + BRAND_BATCH_CAP);
    const response = await fetchWithRetry(`${url}/internal/brands?ids=${encodeURIComponent(chunk.join(","))}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`[features-service] brand-service /internal/brands batch failed (${response.status}): ${body}`);
    }
    const data = (await response.json()) as {
      brands?: Array<{ id?: string; name?: string | null; domain?: string | null }>;
    };
    if (!Array.isArray(data.brands)) {
      throw new Error("[features-service] brand-service /internal/brands returned no brands array");
    }
    for (const b of data.brands) {
      if (typeof b.id !== "string") continue;
      out.set(b.id, { name: b.name ?? null, domain: b.domain ?? null });
    }
  }
  return out;
}
