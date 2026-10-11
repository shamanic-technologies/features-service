/**
 * REVENUE IS CASH THE CLIENT PAID (owner rule 2026-10-11). A granted or advanced credit being consumed is
 * never revenue: an org that never paid us a cent (Aireena: $0 cash, $9.51 of its $30 signup advance
 * consumed in 2026-10) earns us nothing, however much it spends.
 *
 * features-service holds the DATED consumption (runs-service per-day actual spend); billing holds the money
 * that funded it (`GET /internal/accounts/by-org/:orgId/cash`): the cash the org paid us to date (net of
 * refunds and lost disputes, whatever it repaid) and the credit it received WITHOUT paying (gifts, advances
 * not repaid). A day's consumption is revenue only for the part cash funded.
 *
 * ORDER: non-cash credit is consumed FIRST, then cash. The welcome credit / signup advance lands at signup,
 * before any payment, so an org's first spend is on it; an advance a later payment repaid is no longer
 * non-cash credit (billing counts that payment as cash), so its consumption becomes cash-funded. Spend past
 * both (a postpaid org running below zero, not yet charged) is not revenue until the charge lands; the next
 * read moves it in.
 *
 * Every staff "revenue" read keyed on consumption goes through `cashFundedDailyCents`: the realized revenue
 * series, net revenue retention (`revenue-history-compute.ts`) and the customer board's paid active days
 * (`customer-health-compute.ts`).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchOrgDailySpendCents } from "./revenue-history-client.js";

export interface OrgCashFunding {
  /** Cash the org paid us to date, net (billing `cash_paid_cents`), in cents. */
  cashPaidCents: number;
  /** Credit it received without paying (billing `non_cash_credit_cents`: gifts, advances not repaid), in cents. */
  nonCashCreditCents: number;
}

/**
 * The cash-funded part of each day's consumption. Days walked oldest first; each day draws on the
 * non-cash credit left, then on the cash left; the day keeps only what cash funded (days funded by
 * nothing but credit are dropped). Pure. Σ out ≤ min(Σ daily, cashPaidCents).
 */
export function cashFundedDailyCents(daily: Map<string, number>, funding: OrgCashFunding): Map<string, number> {
  let creditLeft = Math.max(0, funding.nonCashCreditCents);
  let cashLeft = Math.max(0, funding.cashPaidCents);
  const out = new Map<string, number>();
  for (const day of [...daily.keys()].sort()) {
    const cents = daily.get(day) ?? 0;
    if (cents <= 0) continue;
    const fromCredit = Math.min(cents, creditLeft);
    creditLeft -= fromCredit;
    const fromCash = Math.min(cents - fromCredit, cashLeft);
    cashLeft -= fromCash;
    if (fromCash > 0) out.set(day, fromCash);
  }
  return out;
}

function billingConfig(): { url: string; apiKey: string } {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  }
  return { url, apiKey };
}

function centsOf(value: unknown, field: string): number {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) {
    throw new Error(`[features-service] billing-service /cash returned non-numeric ${field}: ${JSON.stringify(value)}`);
  }
  return n;
}

/** billing `GET /internal/accounts/by-org/:orgId/cash` (api-key only). Fail loud. */
export async function fetchOrgCashFunding(orgId: string): Promise<OrgCashFunding> {
  const { url, apiKey } = billingConfig();
  const response = await fetchWithRetry(`${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}/cash`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[features-service] billing-service /internal/accounts/by-org/:orgId/cash failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { cash_paid_cents?: unknown; non_cash_credit_cents?: unknown };
  return {
    cashPaidCents: centsOf(data.cash_paid_cents, "cash_paid_cents"),
    nonCashCreditCents: centsOf(data.non_cash_credit_cents, "non_cash_credit_cents"),
  };
}

export interface OrgPaidActivity {
  /** Cash the org paid us to date, USD. */
  cashPaidUsd: number;
  /** UTC days (ascending) on which cash funded some of the org's cold-email consumption. */
  paidActiveDays: string[];
}

/** One org's cash paid + the days cash funded its cold-email consumption. Fail loud. */
export async function fetchOrgPaidActivity(orgId: string, coldEmailSlugsCsv: string, sinceIso: string): Promise<OrgPaidActivity> {
  const [daily, funding] = await Promise.all([
    fetchOrgDailySpendCents(orgId, coldEmailSlugsCsv, sinceIso),
    fetchOrgCashFunding(orgId),
  ]);
  return {
    cashPaidUsd: Math.round(funding.cashPaidCents) / 100,
    paidActiveDays: [...cashFundedDailyCents(daily, funding).keys()].sort(),
  };
}
