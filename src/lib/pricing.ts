/**
 * GROSS vs NET pricing selector for the customer-facing cost-metric stat endpoints
 * (`/revenue`, `/stats`, `/audience-stats`, `/workflow-projection`).
 *
 * The platform can grant an org a per-org USAGE DISCOUNT (a percentage). A discounted org's dashboard
 * must be able to see its cost metrics at the NET (discounted) price it actually pays, so the numbers
 * stay coherent with the "you have X% off" banner. Staff / internal reporting want the GROSS (real,
 * undiscounted) numbers — so GROSS is the DEFAULT and every existing caller (which sends no selector)
 * is byte-identical to today.
 *
 * WHERE the net figure comes from — runs-service's FROZEN net, NOT a read-time discount computation.
 * runs-service freezes each cost row's usage discount AT WRITE TIME (runs-service#179): every cost
 * aggregation now returns BOTH the gross fields (`totalCostInUsdCents` / `actualCostInUsdCents` /
 * `provisionedCostInUsdCents`) AND their frozen-NET twins (`netTotalCostInUsdCents` /
 * `netActualCostInUsdCents` / `netProvisionedCostInUsdCents`, gross reduced by each row's frozen
 * discount). So NET pricing simply READS the net twin instead of the gross field — features-service
 * does NOT fetch a discount percentage and does NOT multiply. Every money metric on these endpoints
 * (total spent, CPC, cost-per-outcome / -close, CAC, ROI, revenue spend, projected budget) is DERIVED
 * from these cost cents, so sourcing the frozen-net cents at the input makes every derived money figure
 * come out net AND coherent by construction (CPC / total-spent / CAC scale down, ROI scales up), with
 * no field-by-field post-hoc classification. Counts, conversion rates, and probabilities never touch
 * cost, so they are unchanged either way.
 *
 * The default is GROSS: every cost producer takes `pricing = "gross"`, so omitting the selector reads
 * the exact gross fields as today. A non-discounted org's frozen net equals its gross per row, so NET
 * == GROSS for it by construction (no special-casing here).
 */

import { refundedCents, type CostBasis } from "./cost-basis.js";

export type Pricing = "gross" | "net" | VendorPricing;

/**
 * STAFF-ONLY cost bases, never parseable from a query string (`parsePricing` accepts gross/net only), so
 * no customer read can be made to answer on them. They are set by the `/internal/.../actual-cost`
 * routes alone (lib/actual-cost-projection.ts, lib/actual-cost-groups.ts).
 *   - `vendor`         — each group's spend at the VENDOR cost of its PRICED rows, before our markup.
 *   - `vendorUnpriced` — each group's BILLED spend on the rows whose vendor cost is NOT known.
 * Both read runs-service `GET /internal/stats/costs/vendor` (service-auth), never the billed
 * aggregations — see {@link runsCostsUrl}.
 */
export type VendorPricing = "vendor" | "vendorUnpriced";

export function isVendorPricing(pricing: Pricing): pricing is VendorPricing {
  return pricing === "vendor" || pricing === "vendorUnpriced";
}

/**
 * The runs-service URL a grouped, undated cost read goes to on this basis. Billed: the org-scoped
 * `/v1/stats/costs` (or the no-auth fleet `/v1/stats/public/costs`). Vendor: the service-auth
 * `/internal/stats/costs/vendor`, which serves both scopes (org from `x-org-id`, fleet without it) and
 * takes a campaign family as `campaignIds` only — so a single `campaignId` is moved onto it here.
 */
export function runsCostsUrl(baseUrl: string, scope: "org" | "public", pricing: Pricing, params: URLSearchParams): string {
  if (!isVendorPricing(pricing)) {
    return `${baseUrl}/v1/stats/${scope === "public" ? "public/costs" : "costs"}?${params}`;
  }
  const p = new URLSearchParams(params);
  const single = p.get("campaignId");
  if (single) {
    p.delete("campaignId");
    p.set("campaignIds", single);
  }
  return `${baseUrl}/internal/stats/costs/vendor?${p}`;
}

/**
 * Parse the `?pricing=` query param. Absent / empty → "gross" (the default — backward-compatible).
 * Returns null for any other value so the caller can 400 (NO Zod `.default()`, NO silent coercion).
 */
export function parsePricing(raw: unknown): Pricing | null {
  if (raw === undefined || raw === null || raw === "") return "gross";
  if (raw === "gross" || raw === "net") return raw;
  return null;
}

/** The runs-service gross cost fields → their frozen-NET twins (runs-service#179). */
export type GrossCostField = "totalCostInUsdCents" | "actualCostInUsdCents" | "provisionedCostInUsdCents";

const NET_FIELD: Record<GrossCostField, string> = {
  totalCostInUsdCents: "netTotalCostInUsdCents",
  actualCostInUsdCents: "netActualCostInUsdCents",
  provisionedCostInUsdCents: "netProvisionedCostInUsdCents",
};

/**
 * Select the gross or frozen-NET cost figure from a runs-service cost group, as its raw string.
 *   - GROSS → the plain `<grossField>` (returned verbatim → byte-identical to today).
 *   - NET   → the frozen `net<GrossField>` twin (runs already reduced it by each cost row's frozen
 *             usage discount at write time — features-service does NOT recompute the discount).
 *
 * Fail-loud (No silent fallback): a missing / non-numeric field THROWS. For NET specifically, a missing
 * net twin must NEVER fall back to the gross figure — that would silently serve undiscounted prices
 * under a NET request (the dashboard would show gross numbers next to a "you have X% off" banner),
 * worse than an error. The throw propagates → the request 502s. GROSS is unaffected.
 */
export function selectCostCentsString(
  group: object,
  grossField: GrossCostField,
  pricing: Pricing,
  // The ACCOUNTING / PERFORMANCE axis (`cost-basis.ts`), ORTHOGONAL to gross/net. "charged" (the
  // default) is what the customer was charged — a comped cost is absent from runs' own totals, so this
  // returns the producer's string VERBATIM and is byte-identical to today. "incurred" adds the
  // refunded (comped) bucket back, because a workflow's cost to produce an outcome does not depend on
  // whether we decided to bill it.
  basis: CostBasis = "charged",
): string {
  if (isVendorPricing(pricing)) return vendorCostCentsString(group, grossField, pricing);
  const field = pricing === "net" ? NET_FIELD[grossField] : grossField;
  const raw = (group as Record<string, unknown>)[field];
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(Number(raw))) {
    throw new Error(
      pricing === "net"
        ? `[features-service] runs-service cost group missing frozen NET field '${field}' ` +
          `(net pricing requested; no silent fallback to gross): ${JSON.stringify(raw)}`
        : `[features-service] runs-service cost group missing '${field}': ${JSON.stringify(raw)}`,
    );
  }
  // A PROVISIONED hold was never charged and can never be comped, so the refund bucket does not touch
  // it — only the committed total and the billed figure carry spend that could have been refunded.
  const refunded = basis === "incurred" && grossField !== "provisionedCostInUsdCents"
    ? refundedCents(group, pricing)
    : 0;
  // Nothing comped ⇒ return the producer's string UNTOUCHED (no reformat, no precision loss), so a
  // fleet with no refunds anywhere is byte-identical on both bases.
  if (refunded === 0) return String(raw);
  return String(Number(raw) + refunded);
}

/** Numeric variant of {@link selectCostCentsString} (parsed to a Number, fail-loud on missing/non-finite). */
export function selectCostCents(
  group: object,
  grossField: GrossCostField,
  pricing: Pricing,
  basis: CostBasis = "charged",
): number {
  return Number(selectCostCentsString(group, grossField, pricing, basis));
}

const VENDOR_PREFIX: Record<VendorPricing, string> = { vendor: "vendor", vendorUnpriced: "unpriced" };
const STATE_OF: Record<GrossCostField, string> = {
  totalCostInUsdCents: "Total",
  actualCostInUsdCents: "Actual",
  provisionedCostInUsdCents: "Provisioned",
};

/**
 * One group's cost on a VENDOR basis. The committed figure (`total`/`actual`) ADDS the refunded
 * bucket: a row we comped was still paid to the vendor, so "what it really cost us" keeps it — the rule
 * the vendor-basis return curve already applies (lib/vendor-spend-by-day-client.ts). A provisioned hold
 * was never spent and carries no refund. The charged/incurred axis therefore does not apply here.
 *
 * FAIL-LOUD on a missing field: a group read off a billed aggregation carries no vendor field, so a
 * cost read that was not routed to the vendor read throws here instead of serving billed money under
 * the vendor name.
 */
function vendorCostCentsString(group: object, grossField: GrossCostField, pricing: VendorPricing): string {
  const row = group as Record<string, unknown>;
  const read = (state: string) => {
    const field = `${VENDOR_PREFIX[pricing]}${state}CostInUsdCents`;
    const raw = row[field];
    if (raw === undefined || raw === null || raw === "" || !Number.isFinite(Number(raw))) {
      throw new Error(`[features-service] runs-service cost group missing vendor-basis field '${field}': ${JSON.stringify(raw)}`);
    }
    return Number(raw);
  };
  const own = read(STATE_OF[grossField]);
  return String(grossField === "provisionedCostInUsdCents" ? own : own + read("Refunded"));
}
