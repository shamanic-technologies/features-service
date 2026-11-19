/**
 * The reads behind `GET /internal/stats/client-financials` (pure compose in `client-financials.ts`).
 *
 * - billing `GET /internal/absorbed-costs` (ONE call): the org universe, billing's own-org / deleted / customer
 *   verdicts, card fees per org.
 * - per org, billing `GET /internal/accounts/by-org/:orgId/{balance,cash}` (404 = no billing account) and runs-service
 *   `GET /internal/stats/costs/margin?orgId=` (gross + net billed, vendor cost, refunded; prod 2026-11-19: 0.1-0.25 s
 *   an org), 4 orgs at a time. A failed org is named in `unreadOrgs`, never a zero row (one slow org must not blank
 *   the board, the accounts-audit lesson of 2026-10-03).
 * - the fleet margin read once (no orgId): `ledgerCoverage` proves Σ every org listed = the ledger's whole platform
 *   spend, and names what no listed org holds.
 * - billing `/internal/revenue/fleet` (MRR, read never re-derived), soft: unreadable = null + reason.
 * - the stated monthly amounts (agency orgs, soft: unreadable = no agency, `agencyBasisUnknown`) and, for a stated
 *   amount with no start date, the brand's first day of platform spend (runs-service, one call per such row).
 *
 * Built off the request path once a body exists: a read serves the last build (memory, else the stored fleet cell)
 * and asks ONE rebuild behind it when older than 15 min; nothing built yet = 503 `client_financials_not_computed_yet`
 * while the first build runs behind.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { mapWithConcurrency } from "./concurrency.js";
import { parseCustomerStatuses } from "./customer-status-client.js";
import { fetchFleetRecurringRevenue, ARR_MONTHS } from "./recurring-revenue-client.js";
import { readStatedAmountsSoft, type StatedAmountRow } from "./stated-monthly-amounts-store.js";
import { claimFleetCellBuild, loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";
import {
  clientFinancialRowOf,
  clientFinancialTotalsOf,
  sortClientRows,
  statedAmountAccruedCents,
  type StatedAmountSpan,
  type ClientFinancialRow,
  type ClientFinancialTotals,
  type FinancialOrgBilling,
  type FinancialOrgIdentity,
  type FinancialOrgLedger,
} from "./client-financials.js";

export const CLIENT_FINANCIALS_FRESH_MS = 15 * 60_000;
const CELL_KEY = "client-financials-v1";
const CLAIM_MS = 10 * 60_000;
const ORG_CONCURRENCY = 4;

export interface ClientFinancialsBody {
  computedAt: string;
  basis: {
    window: "since_inception";
    money: string;
    revenue: string;
    cost: string;
    margin: string;
    excluded: string;
  };
  totals: ClientFinancialTotals;
  clients: ClientFinancialRow[];
  ownOrgs: ClientFinancialRow[];
  ownOrgsTotals: ClientFinancialTotals;
  unreadOrgs: Array<{ orgId: string; orgName: string | null; reason: string }>;
  recurringRevenue: {
    mrrUsd: number | null;
    arrUsd: number | null;
    payingOrgs: number | null;
    mrrUnknownOrgIds: string[];
    unavailableReason: string | null;
  };
  agencyBasisUnknown: boolean;
  ledgerCoverage: {
    fleetBilledUsd: number;
    fleetVendorCostUsd: number;
    listedBilledUsd: number;
    listedVendorCostUsd: number;
    notOnAnyListedOrgBilledUsd: number;
    notOnAnyListedOrgVendorCostUsd: number;
  } | null;
  ledgerCoverageUnavailableReason: string | null;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[features-service] ${name} not configured`);
  return v;
}

async function getJson(url: string, apiKey: string, what: string): Promise<{ status: number; body: unknown }> {
  const res = await fetchWithRetry(url, { headers: { "x-api-key": apiKey } });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`[features-service] ${what} failed (${res.status}): ${await res.text().catch(() => "")}`);
  return { status: res.status, body: await res.json() };
}

function centsField(body: unknown, field: string, what: string): number {
  const raw = (body as Record<string, unknown> | null)?.[field];
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error(`[features-service] ${what}: ${field} is not a number: ${JSON.stringify(raw)}`);
  return n;
}

/** billing's universe + verdicts + card fees. Fails loud. */
export async function fetchFinancialIdentities(): Promise<FinancialOrgIdentity[]> {
  const url = env("BILLING_SERVICE_URL");
  const { body } = await getJson(`${url}/internal/absorbed-costs`, env("BILLING_SERVICE_API_KEY"), "billing GET /internal/absorbed-costs");
  if (body === null) throw new Error("[features-service] billing GET /internal/absorbed-costs answered 404");
  const verdicts = parseCustomerStatuses(body);
  const customers = (body as { customers: Array<Record<string, unknown>> }).customers;
  return customers.map((c) => {
    const v = verdicts.get(c.orgId as string)!;
    if (typeof c.cardFeesCents !== "string") {
      throw new Error(`[features-service] billing absorbed-costs: cardFeesCents is not text for org ${v.orgId}`);
    }
    const other = Array.isArray(c.cardFeesOtherCurrencies) ? c.cardFeesOtherCurrencies : [];
    return {
      orgId: v.orgId,
      orgName: v.orgName,
      customerStatus: v.customerStatus,
      ownOrg: v.ownOrg,
      ownOrgReason: v.ownOrgReason,
      orgDeleted: v.orgDeleted,
      cardFeesCents: c.cardFeesCents,
      cardFeesOtherCurrencies: other.map((o) => ({
        currency: String((o as Record<string, unknown>).currency),
        feeCents: String((o as Record<string, unknown>).feeCents),
      })),
    };
  });
}

/** The org's billing account, null when billing holds none (404). Fails loud otherwise. */
export async function fetchFinancialBilling(orgId: string): Promise<FinancialOrgBilling | null> {
  const url = env("BILLING_SERVICE_URL");
  const key = env("BILLING_SERVICE_API_KEY");
  const base = `${url}/internal/accounts/by-org/${encodeURIComponent(orgId)}`;
  const [balance, cash] = await Promise.all([
    getJson(`${base}/balance`, key, "billing /balance"),
    getJson(`${base}/cash`, key, "billing /cash"),
  ]);
  if (balance.status === 404 || cash.status === 404) return null;
  return {
    creditedCents: centsField(cash.body, "credited_cents", "billing /cash"),
    cashPaidCents: centsField(cash.body, "cash_paid_cents", "billing /cash"),
    nonCashCreditCents: centsField(cash.body, "non_cash_credit_cents", "billing /cash"),
    actualBalanceCents: centsField(balance.body, "actual_balance_cents", "billing /balance"),
    spendableBalanceCents: centsField(balance.body, "balance_cents", "billing /balance"),
  };
}

const LEDGER_FIELDS = [
  "billedCostInUsdCents",
  "netBilledCostInUsdCents",
  "vendorCostInUsdCents",
  "unpricedBilledCostInUsdCents",
  "refundedCostInUsdCents",
  "vendorRefundedCostInUsdCents",
  "unpricedRefundedCostInUsdCents",
] as const;

/** runs-service's since-inception margin total, one org or (no org) the whole platform. Fails loud. */
export async function fetchFinancialLedger(orgId: string | null): Promise<FinancialOrgLedger> {
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  const what = "runs-service GET /internal/stats/costs/margin";
  const { status, body } = await getJson(`${env("RUNS_SERVICE_URL")}/internal/stats/costs/margin${qs}`, env("RUNS_SERVICE_API_KEY"), what);
  if (status === 404) throw new Error(`[features-service] ${what} answered 404`);
  const total = (body as { total?: Record<string, unknown> } | null)?.total;
  if (!total) throw new Error(`[features-service] ${what}: body carries no total`);
  const out = {} as Record<(typeof LEDGER_FIELDS)[number], string>;
  for (const f of LEDGER_FIELDS) {
    if (typeof total[f] !== "string") throw new Error(`[features-service] ${what}: total.${f} is not text`);
    out[f] = total[f] as string;
  }
  return out;
}

/** First UTC day the (org, brand) had actualized platform spend, any feature. null = never. Fails loud. */
export async function fetchFirstSpendDay(orgId: string, brandId: string): Promise<string | null> {
  const params = new URLSearchParams({ interval: "day", orgId, brandId, startedAfter: "2025-01-01T00:00:00.000Z", tz: "UTC" });
  const what = "runs-service /v1/stats/public/costs/timeseries (first spend day)";
  const { status, body } = await getJson(`${env("RUNS_SERVICE_URL")}/v1/stats/public/costs/timeseries?${params}`, env("RUNS_SERVICE_API_KEY"), what);
  if (status === 404) throw new Error(`[features-service] ${what} answered 404`);
  const buckets = (body as { buckets?: Array<{ period?: unknown; actualCostInUsdCents?: unknown }> } | null)?.buckets;
  if (!Array.isArray(buckets)) throw new Error(`[features-service] ${what}: no buckets array`);
  const days = buckets
    .filter((b) => typeof b.period === "string" && Number(b.actualCostInUsdCents) > 0)
    .map((b) => (b.period as string).slice(0, 10))
    .sort();
  return days[0] ?? null;
}

/** An agency org's stated amounts accrued to today, cents. A row with no start runs from the brand's first spend day (never spent = nothing accrued). */
async function agencyAccruedCents(rows: StatedAmountRow[], todayIso: string, deps: ClientFinancialsDeps): Promise<number> {
  const spans: StatedAmountSpan[] = [];
  for (const r of rows) {
    const start = r.startDate ?? (await deps.firstSpendDay(r.orgId, r.brandId));
    if (start !== null) spans.push({ amountUsd: r.amountUsd, startDate: start, endDate: r.endDate });
  }
  return statedAmountAccruedCents(spans, todayIso);
}

export interface ClientFinancialsDeps {
  identities: () => Promise<FinancialOrgIdentity[]>;
  billing: (orgId: string) => Promise<FinancialOrgBilling | null>;
  ledger: (orgId: string | null) => Promise<FinancialOrgLedger>;
  statedAmounts: () => Promise<StatedAmountRow[] | null>;
  /** First UTC day the (org, brand) had platform spend, null = never. */
  firstSpendDay: (orgId: string, brandId: string) => Promise<string | null>;
  recurring: () => Promise<{ orgs: Array<{ orgId: string; mrrCents: string | null }>; unreadableOrgIds: string[] }>;
  now: () => Date;
}

export const defaultClientFinancialsDeps: ClientFinancialsDeps = {
  identities: fetchFinancialIdentities,
  billing: fetchFinancialBilling,
  ledger: fetchFinancialLedger,
  statedAmounts: readStatedAmountsSoft,
  firstSpendDay: fetchFirstSpendDay,
  recurring: fetchFleetRecurringRevenue,
  now: () => new Date(),
};

const toCents = (usd: number) => Math.round(usd * 100);

export async function buildClientFinancials(deps: ClientFinancialsDeps = defaultClientFinancialsDeps): Promise<ClientFinancialsBody> {
  const [identities, statedRows, fleetLedger] = await Promise.all([
    deps.identities(),
    deps.statedAmounts(),
    deps.ledger(null).then(
      (l) => ({ ok: true as const, l }),
      (err: unknown) => ({ ok: false as const, reason: String(err instanceof Error ? err.message : err) }),
    ),
  ]);
  const statedByOrg = new Map<string, StatedAmountRow[]>();
  for (const r of statedRows ?? []) statedByOrg.set(r.orgId, [...(statedByOrg.get(r.orgId) ?? []), r]);
  const todayIso = deps.now().toISOString().slice(0, 10);
  const unreadOrgs: ClientFinancialsBody["unreadOrgs"] = [];
  const rows = (
    await mapWithConcurrency(identities, ORG_CONCURRENCY, async (identity) => {
      try {
        const stated = statedByOrg.get(identity.orgId);
        const [billing, ledger, agencyStatedCents] = await Promise.all([
          deps.billing(identity.orgId),
          deps.ledger(identity.orgId),
          stated ? agencyAccruedCents(stated, todayIso, deps) : Promise.resolve(null),
        ]);
        return clientFinancialRowOf({ identity, billing, ledger, agencyStatedCents });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[features-service] client financials: org ${identity.orgId} unread:`, reason);
        unreadOrgs.push({ orgId: identity.orgId, orgName: identity.orgName, reason });
        return null;
      }
    })
  ).filter((r): r is ClientFinancialRow => r !== null);

  const clients = sortClientRows(rows.filter((r) => !r.ownOrg));
  const ownOrgs = sortClientRows(rows.filter((r) => r.ownOrg));

  let recurringRevenue: ClientFinancialsBody["recurringRevenue"];
  try {
    const rec = await deps.recurring();
    const clientIds = new Set(clients.map((c) => c.orgId));
    let mrrCents = 0;
    let paying = 0;
    const unknown: string[] = [...rec.unreadableOrgIds.filter((id) => clientIds.has(id))];
    for (const o of rec.orgs) {
      if (!clientIds.has(o.orgId)) continue;
      if (o.mrrCents === null) {
        unknown.push(o.orgId);
        continue;
      }
      const c = Number(o.mrrCents);
      mrrCents += c;
      if (c > 0) paying += 1;
    }
    recurringRevenue = {
      mrrUsd: Math.round(mrrCents) / 100,
      arrUsd: Math.round(mrrCents * ARR_MONTHS) / 100,
      payingOrgs: paying,
      mrrUnknownOrgIds: unknown.sort(),
      unavailableReason: null,
    };
  } catch (err) {
    console.error("[features-service] client financials: billing recurring revenue unread:", err);
    recurringRevenue = { mrrUsd: null, arrUsd: null, payingOrgs: null, mrrUnknownOrgIds: [], unavailableReason: "billing_revenue_unavailable" };
  }

  let ledgerCoverage: ClientFinancialsBody["ledgerCoverage"] = null;
  let ledgerCoverageUnavailableReason: string | null = null;
  if (!fleetLedger.ok) {
    ledgerCoverageUnavailableReason = "fleet_ledger_unreadable";
  } else if (unreadOrgs.length > 0) {
    ledgerCoverageUnavailableReason = "some_orgs_unread";
  } else {
    const fleetBilled = Math.round(Number(fleetLedger.l.billedCostInUsdCents) + Number(fleetLedger.l.refundedCostInUsdCents));
    const fleetVendor = Math.round(Number(fleetLedger.l.vendorCostInUsdCents)) + Math.round(Number(fleetLedger.l.vendorRefundedCostInUsdCents));
    const listedBilled = rows.reduce((s, r) => s + toCents(r.consumedUsd.beforeDiscount) + toCents(r.refundedSpendUsd), 0);
    const listedVendor = rows.reduce((s, r) => s + toCents(r.costUsd.vendorOnChargedSpend) + toCents(r.costUsd.vendorOnRefundedSpend), 0);
    ledgerCoverage = {
      fleetBilledUsd: fleetBilled / 100,
      fleetVendorCostUsd: fleetVendor / 100,
      listedBilledUsd: listedBilled / 100,
      listedVendorCostUsd: listedVendor / 100,
      notOnAnyListedOrgBilledUsd: (fleetBilled - listedBilled) / 100,
      notOnAnyListedOrgVendorCostUsd: (fleetVendor - listedVendor) / 100,
    };
  }

  return {
    computedAt: deps.now().toISOString(),
    basis: {
      window: "since_inception",
      money:
        "USD. `net` = what the org pays, after its usage discount; `beforeDiscount` = the same at list price. Cost is never discounted.",
      revenue:
        "The cash-funded part of what billing charged the org (credited minus actual balance): charged x cash paid / (cash paid + credit given without payment), never above the cash paid. Credit we gave that the org consumed is not revenue. An agency org pays off-platform: its revenue is its stated monthly amounts accrued per day in force (amount x 12 / 365), its on-platform charges shown beside, not added.",
      cost:
        "What serving the org cost us: the vendors' charge for every platform cost row of the org (charged and refunded rows), plus the card fees of its payments.",
      margin: "Revenue minus cost. Null only when more than 1% of the org's billed spend has no vendor cost on record.",
      excluded:
        "Our own orgs (platform, staff, test orgs, kevin@pressbeat.io) are listed apart in ownOrgs and in no total. Deleted orgs stay listed (former clients).",
    },
    totals: clientFinancialTotalsOf(clients),
    clients,
    ownOrgs,
    ownOrgsTotals: clientFinancialTotalsOf(ownOrgs),
    unreadOrgs: unreadOrgs.sort((a, b) => a.orgId.localeCompare(b.orgId)),
    recurringRevenue,
    agencyBasisUnknown: statedRows === null,
    ledgerCoverage,
    ledgerCoverageUnavailableReason,
  };
}

// ── Served copy: memory, else stored cell; one rebuild behind ─────────────

let held: { body: ClientFinancialsBody; at: number } | null = null;
let building: Promise<ClientFinancialsBody> | null = null;

export function __resetClientFinancials(): void {
  held = null;
  building = null;
}

function rebuild(deps: ClientFinancialsDeps): Promise<ClientFinancialsBody> {
  if (building) return building;
  building = (async () => {
    const body = await buildClientFinancials(deps);
    const at = Date.parse(body.computedAt);
    held = { body, at };
    await storeFleetCell(CELL_KEY, JSON.stringify(body), at);
    return body;
  })().finally(() => {
    building = null;
  });
  return building;
}

export class ClientFinancialsNotBuiltError extends Error {
  constructor() {
    super("client financials not computed yet: the first build is running, retry in about 2 minutes");
  }
}

/** The last build (rebuilt behind when stale); nothing built yet = a build starts behind and the read throws `ClientFinancialsNotBuiltError`. */
export async function readClientFinancials(deps: ClientFinancialsDeps = defaultClientFinancialsDeps): Promise<ClientFinancialsBody> {
  if (!held) {
    const stored = await loadFleetCell(CELL_KEY);
    if (stored) held = { body: JSON.parse(stored.text) as ClientFinancialsBody, at: stored.computedAt };
  }
  if (!held) {
    // A cold build takes ~1-2 min (prod 2026-11-19): never hold a request on it.
    rebuild(deps).catch((err) => console.error("[features-service] client financials cold build failed:", err));
    throw new ClientFinancialsNotBuiltError();
  }
  if (Date.now() - held.at > CLIENT_FINANCIALS_FRESH_MS && !building) {
    claimFleetCellBuild(CELL_KEY, CLAIM_MS)
      .then(async (mine) => {
        if (mine) return rebuild(deps);
        // Another process is rebuilding: take its stored copy once newer than ours.
        const stored = await loadFleetCell(CELL_KEY);
        if (stored && held && stored.computedAt > held.at) {
          held = { body: JSON.parse(stored.text) as ClientFinancialsBody, at: stored.computedAt };
        }
        return null;
      })
      .catch((err) => console.error("[features-service] client financials background rebuild failed:", err));
  }
  return held.body;
}
