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

export type Pricing = "gross" | "net";

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
): string {
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
  return String(raw);
}

/** Numeric variant of {@link selectCostCentsString} (parsed to a Number, fail-loud on missing/non-finite). */
export function selectCostCents(
  group: object,
  grossField: GrossCostField,
  pricing: Pricing,
): number {
  return Number(selectCostCentsString(group, grossField, pricing));
}
