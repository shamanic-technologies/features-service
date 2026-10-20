/**
 * The two reads that close the org Usage breakdown on what billing actually bills (USAGE-MATCHES-BILLED-1021,
 * `lib/usage-categories.ts`):
 *   - runs-service `GET /internal/org-no-campaign-total?org_id&since` — the org's spend with no campaign
 *     since billing's cutover, the SAME read billing-service makes to absorb it (lib/transfer-usage);
 *   - billing-service's own figures, from two pure user-less reads: `credited_cents`
 *     (`/internal/accounts/by-org/:orgId/cash`) and `balance_cents` + `actual_balance_cents`
 *     (`/internal/accounts/by-org/:orgId/balance`). Billed = credited − actual balance, Set aside = actual
 *     balance − balance: the exact arithmetic the Billing page prints.
 * Both fail LOUD (a swallowed read would print a wrong bill); billing's 404 (no account) is a definite
 * "none", returned as null.
 */
import { addDecimals } from "./decimal.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { AbsorbedCents, BillingCents } from "./usage-categories.js";

const neg = (x: string): string => (x.startsWith("-") ? x.slice(1) : `-${x}`);

function decimalField(body: Record<string, unknown>, field: string, what: string): string {
  const raw = body[field];
  const str = typeof raw === "number" ? String(raw) : raw;
  if (typeof str !== "string" || !/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`[features-service] ${what} returned no decimal ${field}: ${JSON.stringify(raw)}`);
  }
  return str;
}

export async function fetchAbsorbedNoCampaignCents(orgId: string, sinceIso: string): Promise<AbsorbedCents> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  const qs = new URLSearchParams({ org_id: orgId, since: sinceIso });
  const what = "runs-service /internal/org-no-campaign-total";
  const res = await fetchWithRetry(`${url}/internal/org-no-campaign-total?${qs}`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`[features-service] ${what} failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as Record<string, unknown>;
  // net_spent_cents = actual + provisioned (billing's projected usage); net_total_expected_cents = the
  // actualized part (billing's actual usage). Same mapping as billing's runs-client.
  const projected = decimalField(body, "net_spent_cents", what);
  const actual = decimalField(body, "net_total_expected_cents", what);
  return { billedCents: actual, setAsideCents: addDecimals(projected, neg(actual)) };
}

export async function fetchBillingBilledCents(orgId: string): Promise<BillingCents | null> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const base = `${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}`;
  const [balanceRes, cashRes] = await Promise.all([
    fetchWithRetry(`${base}/balance`, { headers: { "x-api-key": apiKey } }),
    fetchWithRetry(`${base}/cash`, { headers: { "x-api-key": apiKey } }),
  ]);
  if (balanceRes.status === 404) return null;
  if (!balanceRes.ok) {
    throw new Error(`[features-service] billing-service /internal/accounts/by-org/:orgId/balance failed (${balanceRes.status}): ${await balanceRes.text()}`);
  }
  if (!cashRes.ok) {
    throw new Error(`[features-service] billing-service /internal/accounts/by-org/:orgId/cash failed (${cashRes.status}): ${await cashRes.text()}`);
  }
  const balance = (await balanceRes.json()) as Record<string, unknown>;
  const cash = (await cashRes.json()) as Record<string, unknown>;
  const balanceCents = decimalField(balance, "balance_cents", "billing-service balance");
  const actualBalanceCents = decimalField(balance, "actual_balance_cents", "billing-service balance");
  const creditedCents = decimalField(cash, "credited_cents", "billing-service cash");
  return {
    billedCents: addDecimals(creditedCents, neg(actualBalanceCents)),
    setAsideCents: addDecimals(actualBalanceCents, neg(balanceCents)),
  };
}
