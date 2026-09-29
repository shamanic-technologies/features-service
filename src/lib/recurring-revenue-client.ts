/**
 * THE ONE ANSWER TO "WHAT IS OUR MRR" — billing-service's recurring revenue, read, never re-derived.
 *
 * Owner decision 2026-09-29: an org is RECURRING when it is postpaid with a chargeable card, or
 * prepaid with auto top-up on and a chargeable card; its DRR is the daily budgets of its PROACTIVE
 * campaigns that are running with an audience left; MRR = DRR × 30, ARR = MRR × 12. A prepaid org
 * without auto top-up or without a card is ONE-OFF and is not MRR. billing-service decides all of it
 * (`GET /internal/revenue/fleet`, billing v0.81.23) and states each org's class, reason and figures.
 * This module reads that verdict and sums it; it re-derives NONE of it (no payment mode, no reactive
 * vs proactive, no audience test here).
 *
 * UNKNOWN STAYS UNKNOWN, on billing's own convention: an org whose MRR billing could not settle
 * (`mrrCents: null`) or whose row billing could not read at all (`unreadableOrgs`) is LISTED beside a
 * sum, never counted as 0. A sum is of the KNOWN rows, exactly as billing's own totals are.
 *
 * The read takes ~15 s in production (billing asks campaign-service per org), so concurrent callers
 * share ONE fetch and a settled answer is reused for `SHARE_MS`. Fails loud: callers decide how an
 * unavailable read degrades (always to `null` with a reason, never to the old computation).
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { sumDecimalStrings } from "./decimal.js";

export const ARR_MONTHS = 12;

/** What billing states for one org. Figures are CENTS as decimal text, exactly as billing serves them. */
export interface OrgRecurringRevenue {
  orgId: string;
  paymentMode: string;
  /** billing's class: `recurring` | `one_off` | `none`. */
  revenueClass: string;
  /** billing's reason for the class (`postpaid_chargeable_card`, `prepaid_no_auto_topup`, …). */
  classReason: string;
  /** MRR in cents (decimal text); "0" for a non-recurring org; null when billing could not settle it. */
  mrrCents: string | null;
  /** billing's reason the figure is unknown, or null. */
  unknownReason: string | null;
}

export interface FleetRecurringRevenue {
  asOf: string;
  orgs: OrgRecurringRevenue[];
  /** Orgs billing could not read at all — unknown, never a 0. */
  unreadableOrgIds: string[];
}

const SHARE_MS = 60_000;
let shared: { at: number; value: FleetRecurringRevenue } | null = null;
let inFlight: Promise<FleetRecurringRevenue> | null = null;

/** Test seam — drop the shared answer. */
export function __resetRecurringRevenueShare(): void {
  shared = null;
  inFlight = null;
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`[features-service] billing revenue fleet: ${what} is not a string`);
  return v;
}

/** Parse billing's `/internal/revenue/fleet` body. Fails loud on a shape it does not recognise. */
export function parseFleetRecurringRevenue(body: unknown): FleetRecurringRevenue {
  const b = body as { asOf?: unknown; orgs?: unknown; unreadableOrgs?: unknown };
  if (!b || !Array.isArray(b.orgs) || !Array.isArray(b.unreadableOrgs)) {
    throw new Error("[features-service] billing revenue fleet: body carries no orgs[] / unreadableOrgs[]");
  }
  const orgs = b.orgs.map((raw): OrgRecurringRevenue => {
    const o = raw as Record<string, unknown>;
    const mrr = o.mrrCents;
    if (mrr !== null && typeof mrr !== "string") {
      throw new Error("[features-service] billing revenue fleet: mrrCents is neither text nor null");
    }
    return {
      orgId: text(o.orgId, "orgId"),
      paymentMode: text(o.paymentMode, "paymentMode"),
      revenueClass: text(o.revenueClass, "revenueClass"),
      classReason: text(o.classReason, "classReason"),
      mrrCents: mrr,
      unknownReason: typeof o.proactiveDailyBudgetUnknownReason === "string" ? o.proactiveDailyBudgetUnknownReason : null,
    };
  });
  const unreadableOrgIds = b.unreadableOrgs.map((u) => text((u as { orgId?: unknown }).orgId, "unreadableOrgs[].orgId"));
  return { asOf: typeof b.asOf === "string" ? b.asOf : new Date().toISOString(), orgs, unreadableOrgIds };
}

async function fetchOnce(): Promise<FleetRecurringRevenue> {
  const url = process.env.BILLING_SERVICE_URL;
  const apiKey = process.env.BILLING_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[features-service] BILLING_SERVICE_URL or BILLING_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(`${url}/internal/revenue/fleet`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) {
    throw new Error(`[features-service] billing GET /internal/revenue/fleet: ${res.status} ${await res.text().catch(() => "")}`);
  }
  return parseFleetRecurringRevenue(await res.json());
}

/** billing's recurring revenue for every org, shared across concurrent callers. Fails loud. */
export async function fetchFleetRecurringRevenue(): Promise<FleetRecurringRevenue> {
  if (shared && Date.now() - shared.at < SHARE_MS) return shared.value;
  if (!inFlight) {
    inFlight = fetchOnce()
      .then((value) => {
        shared = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** A sum of known MRRs, with the orgs that could not be counted listed beside it. */
export interface RecurringMrrSum {
  /** Σ known MRR, USD, exact to the cent (summed on billing's decimal text, converted once). */
  mrrUsd: number;
  /** Orgs in scope whose MRR billing could not state (null figure, or unreadable) — never counted as 0. */
  unknownOrgIds: string[];
  /** Orgs in scope contributing a positive MRR. */
  contributingOrgCount: number;
}

/** Round a USD amount to 2 decimals, FP-safe. */
function usd2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Σ billing's MRR over the orgs `inScope` admits. Exact on the decimal text; unknown orgs listed, not
 * summed. Pure.
 */
export function sumRecurringMrr(
  fleet: Pick<FleetRecurringRevenue, "orgs" | "unreadableOrgIds">,
  inScope: (orgId: string) => boolean = () => true,
): RecurringMrrSum {
  const known: string[] = [];
  const unknownOrgIds: string[] = [];
  let contributingOrgCount = 0;
  for (const o of fleet.orgs) {
    if (!inScope(o.orgId)) continue;
    if (o.mrrCents === null) {
      unknownOrgIds.push(o.orgId);
      continue;
    }
    known.push(o.mrrCents);
    if (Number(o.mrrCents) > 0) contributingOrgCount += 1;
  }
  for (const id of fleet.unreadableOrgIds) if (inScope(id)) unknownOrgIds.push(id);
  const cents = sumDecimalStrings(known, "billing mrrCents");
  return { mrrUsd: usd2(Number(cents) / 100), unknownOrgIds: unknownOrgIds.sort(), contributingOrgCount };
}
