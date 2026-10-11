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
 * SPLIT: each day's consumption is cash in the org's CASH SHARE, cash ÷ (cash + non-cash credit), and the
 * cumulative cash-funded total never exceeds the cash paid. Money in a balance is fungible, so no order
 * (credit first, cash first) is a fact; a share moves no revenue in time (2026-10-11: "credit first" read
 * Living Vital, $400 paid + $400 welcome match, as never paying). Aireena: share 0, no revenue. Spend past
 * the cash (a postpaid org below zero, not charged yet) is not revenue until the charge lands.
 *
 * AGENCY orgs (holding an owner-stated monthly amount, `agencyOrgIdsOf`) pay us OFF-PLATFORM: billing sees
 * only the staff grants that credit that money, as non-cash. Their consumption is cash-funded in full
 * (`AGENCY_FUNDING`); their revenue is the stated amount on the MRR split.
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

/** An agency org's funding: all cash (paid off-platform, see header). */
export const AGENCY_FUNDING: OrgCashFunding = { cashPaidCents: Number.POSITIVE_INFINITY, nonCashCreditCents: 0 };

/**
 * The cash-funded part of each day's consumption: the day × the org's cash share, the running total capped
 * at the cash paid. Days with no cash part are dropped. Pure. Σ out ≤ min(Σ daily, cashPaidCents).
 */
export function cashFundedDailyCents(daily: Map<string, number>, funding: OrgCashFunding): Map<string, number> {
  const cash = Math.max(0, funding.cashPaidCents);
  const credit = Math.max(0, funding.nonCashCreditCents);
  const share = cash === 0 ? 0 : cash === Number.POSITIVE_INFINITY ? 1 : cash / (cash + credit);
  let cashLeft = cash;
  const out = new Map<string, number>();
  for (const day of [...daily.keys()].sort()) {
    const cents = daily.get(day) ?? 0;
    if (cents <= 0 || cashLeft <= 0) continue;
    const fromCash = Math.min(cents * share, cashLeft);
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

/**
 * One org's cash paid (billing; an agency's off-platform payments are not in it) + the days cash funded
 * its cold-email consumption. `isAgency` = the org holds a stated monthly amount. Fail loud.
 */
export async function fetchOrgPaidActivity(
  orgId: string,
  coldEmailSlugsCsv: string,
  sinceIso: string,
  isAgency: boolean,
): Promise<OrgPaidActivity> {
  const [daily, funding] = await Promise.all([
    fetchOrgDailySpendCents(orgId, coldEmailSlugsCsv, sinceIso),
    fetchOrgCashFunding(orgId),
  ]);
  return {
    cashPaidUsd: Math.round(funding.cashPaidCents) / 100,
    paidActiveDays: [...cashFundedDailyCents(daily, isAgency ? AGENCY_FUNDING : funding).keys()].sort(),
  };
}
