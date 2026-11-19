/**
 * WHAT EACH CLIENT PAYS US, COSTS US, AND THE MARGIN WE MAKE (DISTRY-PRINCIPAL-1119, owner 2026-11-19: Distry, our AI
 * CEO, « needs to access all financials of the company via tools, including the costs, revenue, margin of each client,
 * either per list, or stats aggregated »). Staff only: the vendor cost reveals our margin. Pure; the reads live in
 * `client-financials-io.ts`. Every figure is since inception (no window is served per org today).
 *
 * Per org, every input read from the service that RECORDS it, never re-derived:
 * - REVENUE = the CASH-funded part of what billing charged the org (owner rule 2026-10-11, `cash-funded-spend.ts`):
 *   charged = billing's credited − actual balance (the Billing page's "Billed", USAGE-MATCHES-BILLED-1021); its cash
 *   part = charged × cash ÷ (cash + credit given without payment), never above the cash paid. Net = what the org pays
 *   (after its usage discount); `beforeDiscount` = the same revenue at list price (runs' gross ÷ net consumption).
 *   An AGENCY org (holding owner-stated monthly amounts, `stated_monthly_amounts`) pays us OFF-PLATFORM: its revenue is
 *   the stated amounts accrued per day in force (amount × 12 ÷ 365 a day, `statedAmountAccruedCents`), the same
 *   amounts the MRR split reads; its on-platform charges are shown beside, never added (prod 2026-11-19, Doc Dinners:
 *   $1,365 charged on-platform beside $2,000 / $1,250 / $1,500 monthly paid by bank transfer).
 * - COST = what serving the org cost US: the vendors' charge for every platform cost row of the org (runs-service
 *   margin read: rows we charged AND rows we refunded, spend that happened and we did not charge), plus the card
 *   acquiring fees of its payments (billing, in USD). A row with no vendor cost on record is named
 *   (`vendorCostUnknownOnUsd`); above 1% of the org's billed spend the margin is null `vendor_cost_unknown` (the
 *   public tolerance, PUBLIC-VENDOR-COST-1031), never a margin at zero cost.
 * - MARGIN = revenue − cost. A client that paid nothing shows its cost and a NEGATIVE margin, never a blank.
 *
 * Totals are the SUM of the client rows, cent for cent (each row is rounded to the cent first): our own orgs (billing's
 * `ownOrg`: platform, staff billing contact, staff test org, kevin@pressbeat.io included) are listed apart and in no
 * total; an org whose reads failed is named in `unreadOrgs` and in no total.
 */

/** One org as billing's absorbed-costs read lists it (identity + verdicts + card fees). */
export interface FinancialOrgIdentity {
  orgId: string;
  orgName: string | null;
  customerStatus: "current" | "churned" | "never_paid" | null;
  ownOrg: boolean;
  ownOrgReason: string | null;
  orgDeleted: boolean;
  /** Card acquiring fees in USD cents, decimal text (billing). */
  cardFeesCents: string;
  /** Fees billing could not convert to USD: served apart, in no figure. */
  cardFeesOtherCurrencies: Array<{ currency: string; feeCents: string }>;
}

/** The org's billing account (null = billing holds none). Cents. */
export interface FinancialOrgBilling {
  creditedCents: number;
  cashPaidCents: number;
  nonCashCreditCents: number;
  /** Credited − charged (what the org still holds), cents. */
  actualBalanceCents: number;
  /** After holds for work in flight, cents. */
  spendableBalanceCents: number;
}

/** runs-service `/internal/stats/costs/margin?orgId=` total (decimal text, cents). */
export interface FinancialOrgLedger {
  billedCostInUsdCents: string;
  netBilledCostInUsdCents: string;
  vendorCostInUsdCents: string;
  unpricedBilledCostInUsdCents: string;
  refundedCostInUsdCents: string;
  vendorRefundedCostInUsdCents: string;
  unpricedRefundedCostInUsdCents: string;
}

export interface FinancialOrgInput {
  identity: FinancialOrgIdentity;
  billing: FinancialOrgBilling | null;
  ledger: FinancialOrgLedger;
  /** An agency org's stated amounts accrued to date, cents; null = not an agency org. */
  agencyStatedCents: number | null;
}

/** A stated monthly amount, as the accrual needs it. */
export interface StatedAmountSpan {
  amountUsd: number;
  /** First UTC day in force, inclusive (null start already resolved by the caller). */
  startDate: string;
  /** Last UTC day in force, inclusive; null = still running. */
  endDate: string | null;
}

const DAY_MS = 86_400_000;

/** Σ amount × 12 ÷ 365 per UTC day in force, from start through min(end, today), inclusive. Pure, cents. */
export function statedAmountAccruedCents(spans: StatedAmountSpan[], todayIso: string): number {
  let total = 0;
  for (const s of spans) {
    const last = s.endDate !== null && s.endDate < todayIso ? s.endDate : todayIso;
    if (last < s.startDate) continue;
    const days = Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${s.startDate}T00:00:00Z`)) / DAY_MS) + 1;
    total += s.amountUsd * 100 * days * (12 / 365);
  }
  return total;
}

/** Above this share of an org's billed spend with no vendor cost on record, its margin is not served. */
export const VENDOR_COST_UNKNOWN_TOLERANCE = 0.01;

export interface MoneyPair {
  /** What the org pays (after its usage discount). */
  net: number;
  /** The same at list price, before the org's usage discount. */
  beforeDiscount: number;
}

export interface ClientFinancialRow {
  orgId: string;
  orgName: string | null;
  customerStatus: FinancialOrgIdentity["customerStatus"];
  orgDeleted: boolean;
  ownOrg: boolean;
  ownOrgReason: string | null;
  agency: boolean;
  /** Agency only: the stated amounts accrued to date (= revenueUsd.net). */
  statedAmountsAccruedUsd: number | null;
  hasBillingAccount: boolean;
  revenueUsd: MoneyPair;
  costUsd: {
    total: number;
    vendorOnChargedSpend: number;
    vendorOnRefundedSpend: number;
    cardFees: number;
    vendorCostUnknownOnUsd: number;
  };
  marginUsd: MoneyPair | null;
  marginPct: { net: number | null; beforeDiscount: number | null } | null;
  marginUnavailableReason: "vendor_cost_unknown" | null;
  marginPctUnavailableReason: "no_revenue" | "vendor_cost_unknown" | null;
  consumedUsd: MoneyPair;
  chargedUsd: number;
  refundedSpendUsd: number;
  cashPaidUsd: number;
  creditGivenUsd: number;
  cashShare: number | null;
  balanceUsd: number;
  spendableBalanceUsd: number;
  cardFeesOtherCurrencies: FinancialOrgIdentity["cardFeesOtherCurrencies"];
}

/** Round to the cent, in cents (an integer). */
const cents = (x: number): number => Math.round(x);
const usd = (c: number): number => c / 100;

function num(text: string, what: string): number {
  const n = Number(text);
  if (typeof text !== "string" || text === "" || !Number.isFinite(n)) {
    throw new Error(`[features-service] client financials: ${what} is not a decimal: ${JSON.stringify(text)}`);
  }
  return n;
}

const pct = (margin: number, revenue: number): number => Math.round((margin / revenue) * 10_000) / 100;

/** One org's row. Pure. Every money figure is rounded to the cent BEFORE any total adds it. */
export function clientFinancialRowOf(input: FinancialOrgInput): ClientFinancialRow {
  const { identity, billing, ledger, agencyStatedCents } = input;
  const agency = agencyStatedCents !== null;
  const consumedGross = num(ledger.billedCostInUsdCents, "billedCostInUsdCents");
  const consumedNet = num(ledger.netBilledCostInUsdCents, "netBilledCostInUsdCents");
  const vendorCharged = num(ledger.vendorCostInUsdCents, "vendorCostInUsdCents");
  const vendorRefunded = num(ledger.vendorRefundedCostInUsdCents, "vendorRefundedCostInUsdCents");
  const refunded = num(ledger.refundedCostInUsdCents, "refundedCostInUsdCents");
  const unknown =
    num(ledger.unpricedBilledCostInUsdCents, "unpricedBilledCostInUsdCents") +
    num(ledger.unpricedRefundedCostInUsdCents, "unpricedRefundedCostInUsdCents");
  const fees = num(identity.cardFeesCents, "cardFeesCents");

  const charged = billing ? Math.max(0, billing.creditedCents - billing.actualBalanceCents) : 0;
  const cash = billing ? Math.max(0, billing.cashPaidCents) : 0;
  const credit = billing ? Math.max(0, billing.nonCashCreditCents) : 0;
  const cashShare = cash + credit > 0 ? cash / (cash + credit) : null;
  // An agency pays its stated amounts off-platform (no usage discount applies to them).
  const revenueNetRaw = agency ? agencyStatedCents : Math.min(charged * (cashShare ?? 0), cash);
  const revenueNet = cents(revenueNetRaw);
  const revenueGross = cents(!agency && consumedNet > 0 ? revenueNetRaw * (consumedGross / consumedNet) : revenueNetRaw);

  const vendorChargedC = cents(vendorCharged);
  const vendorRefundedC = cents(vendorRefunded);
  const feesC = cents(fees);
  const costTotal = vendorChargedC + vendorRefundedC + feesC;
  const billedBase = consumedGross + refunded;
  const costUnknown = unknown > 0 && (billedBase <= 0 || unknown / billedBase > VENDOR_COST_UNKNOWN_TOLERANCE);

  const marginNet = revenueNet - costTotal;
  const marginGross = revenueGross - costTotal;
  return {
    orgId: identity.orgId,
    orgName: identity.orgName,
    customerStatus: identity.customerStatus,
    orgDeleted: identity.orgDeleted,
    ownOrg: identity.ownOrg,
    ownOrgReason: identity.ownOrgReason,
    agency,
    statedAmountsAccruedUsd: agency ? usd(revenueNet) : null,
    hasBillingAccount: billing !== null,
    revenueUsd: { net: usd(revenueNet), beforeDiscount: usd(revenueGross) },
    costUsd: {
      total: usd(costTotal),
      vendorOnChargedSpend: usd(vendorChargedC),
      vendorOnRefundedSpend: usd(vendorRefundedC),
      cardFees: usd(feesC),
      vendorCostUnknownOnUsd: usd(cents(unknown)),
    },
    marginUsd: costUnknown ? null : { net: usd(marginNet), beforeDiscount: usd(marginGross) },
    marginPct: costUnknown
      ? null
      : {
          net: revenueNet > 0 ? pct(marginNet, revenueNet) : null,
          beforeDiscount: revenueGross > 0 ? pct(marginGross, revenueGross) : null,
        },
    marginUnavailableReason: costUnknown ? "vendor_cost_unknown" : null,
    marginPctUnavailableReason: costUnknown ? "vendor_cost_unknown" : revenueNet > 0 ? null : "no_revenue",
    consumedUsd: { net: usd(cents(consumedNet)), beforeDiscount: usd(cents(consumedGross)) },
    chargedUsd: usd(cents(charged)),
    refundedSpendUsd: usd(cents(refunded)),
    cashPaidUsd: usd(cents(cash)),
    creditGivenUsd: usd(cents(credit)),
    cashShare: cashShare === null ? null : Math.round(cashShare * 10_000) / 10_000,
    balanceUsd: billing ? usd(cents(billing.actualBalanceCents)) : 0,
    spendableBalanceUsd: billing ? usd(cents(billing.spendableBalanceCents)) : 0,
    cardFeesOtherCurrencies: identity.cardFeesOtherCurrencies,
  };
}

export interface ClientFinancialTotals {
  clients: number;
  clientsWithRevenue: number;
  clientsWithNegativeMargin: number;
  /** Clients whose margin is not served (vendor cost unknown): their revenue and cost are in the totals, the margin total leaves them out. */
  clientsWithMarginUnknown: number;
  revenueUsd: MoneyPair;
  costUsd: ClientFinancialRow["costUsd"];
  /** Σ client margins (rows with a margin only). */
  marginUsd: MoneyPair;
  marginPct: { net: number | null; beforeDiscount: number | null };
  consumedUsd: MoneyPair;
  chargedUsd: number;
  refundedSpendUsd: number;
  cashPaidUsd: number;
  creditGivenUsd: number;
  /** What clients still hold on their accounts (credited − charged), cash and credit alike. */
  balanceUsd: number;
  spendableBalanceUsd: number;
}

/** Sum rows in integer cents, so the total equals the rows to the cent. */
function sumCents(rows: ClientFinancialRow[], pick: (r: ClientFinancialRow) => number): number {
  return rows.reduce((s, r) => s + Math.round(pick(r) * 100), 0);
}

export function clientFinancialTotalsOf(rows: ClientFinancialRow[]): ClientFinancialTotals {
  const s = (pick: (r: ClientFinancialRow) => number) => usd(sumCents(rows, pick));
  const withMargin = rows.filter((r) => r.marginUsd !== null);
  const revNetWithMargin = sumCents(withMargin, (r) => r.revenueUsd.net);
  const revGrossWithMargin = sumCents(withMargin, (r) => r.revenueUsd.beforeDiscount);
  const marginNet = sumCents(withMargin, (r) => r.marginUsd!.net);
  const marginGross = sumCents(withMargin, (r) => r.marginUsd!.beforeDiscount);
  return {
    clients: rows.length,
    clientsWithRevenue: rows.filter((r) => r.revenueUsd.net > 0).length,
    clientsWithNegativeMargin: withMargin.filter((r) => r.marginUsd!.net < 0).length,
    clientsWithMarginUnknown: rows.length - withMargin.length,
    revenueUsd: { net: s((r) => r.revenueUsd.net), beforeDiscount: s((r) => r.revenueUsd.beforeDiscount) },
    costUsd: {
      total: s((r) => r.costUsd.total),
      vendorOnChargedSpend: s((r) => r.costUsd.vendorOnChargedSpend),
      vendorOnRefundedSpend: s((r) => r.costUsd.vendorOnRefundedSpend),
      cardFees: s((r) => r.costUsd.cardFees),
      vendorCostUnknownOnUsd: s((r) => r.costUsd.vendorCostUnknownOnUsd),
    },
    marginUsd: { net: usd(marginNet), beforeDiscount: usd(marginGross) },
    marginPct: {
      net: revNetWithMargin > 0 ? pct(marginNet, revNetWithMargin) : null,
      beforeDiscount: revGrossWithMargin > 0 ? pct(marginGross, revGrossWithMargin) : null,
    },
    consumedUsd: { net: s((r) => r.consumedUsd.net), beforeDiscount: s((r) => r.consumedUsd.beforeDiscount) },
    chargedUsd: s((r) => r.chargedUsd),
    refundedSpendUsd: s((r) => r.refundedSpendUsd),
    cashPaidUsd: s((r) => r.cashPaidUsd),
    creditGivenUsd: s((r) => r.creditGivenUsd),
    balanceUsd: s((r) => r.balanceUsd),
    spendableBalanceUsd: s((r) => r.spendableBalanceUsd),
  };
}

/** Clients first by revenue (net) desc, then cost desc, then org id. Pure. */
export function sortClientRows(rows: ClientFinancialRow[]): ClientFinancialRow[] {
  return [...rows].sort(
    (a, b) =>
      b.revenueUsd.net - a.revenueUsd.net || b.costUsd.total - a.costUsd.total || a.orgId.localeCompare(b.orgId),
  );
}
