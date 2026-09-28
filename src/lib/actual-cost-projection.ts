/**
 * THE WORKFLOW LADDER ON ACTUAL COST — `workflow-projection`'s money read at VENDOR cost, before our
 * markup. STAFF ONLY, for the same reason the actual-cost return curve is (lib/actual-cost-history.ts):
 * billed ÷ vendor IS our markup, so this basis is never a parameter of a customer read. It is served on
 * its own `/internal/...` path the api-service gateway mounts behind its staff gate.
 *
 * THREE PROJECTIONS OF ONE LADDER, ONE PURE MERGE. The route projects the same request three times off
 * three evidence reads that differ ONLY in which cost figure each runs-service group carries:
 *
 *   - BILLED  — the customer read, byte for byte. It decides the ORDER: `rank`, `scopeRank`, the
 *               recommendation. The ranking is what campaign-service acts on, so flipping a staff
 *               switch must never move it.
 *   - VENDOR  — the same ladder with every group's spend at the vendor cost of its PRICED rows. Every
 *               money figure (spend, unit costs, cost per outcome, ROI, CAC) is read from it, so the
 *               floors and the funnel walk apply to vendor spend exactly as they apply to billed.
 *   - UNPRICED — the same ladder with every group's spend at the BILLED amount of the rows whose vendor
 *               cost is NOT known. Only its per-grain spend is read: it says where the vendor figures
 *               would be understated.
 *
 * AN UNPRICED GRAIN IS STATED, NEVER BORROWED. A grain whose spend includes rows we cannot price at
 * vendor cost has an unknown vendor spend, so its money reads null and it names the billed amount it
 * could not price. A finer grain FLOORS against the coarser ones (crossOrg → brand → campaign →
 * audience; offer against brand), so it is unknown as soon as any grain it stands on is. The billed
 * figure is never substituted and the priced part is never passed off as the whole: the priced vendor
 * cost rides beside the unpriced billed amount as what we DO know.
 *
 * Counts, rates and outcome counts are identical on the three reads (same rows, same outcomes), so the
 * vendor projection's are served as they are.
 */

import type { GrainName, ProjectionRow, WorkflowProjectionResponse } from "../routes/workflow-projection.js";

/** The grains a grain floors against, coarsest first (see `resolvePick` / the cascade). */
const PARENTS: Record<GrainName, GrainName[]> = {
  crossOrg: [],
  brand: ["crossOrg"],
  offer: ["crossOrg", "brand"],
  campaign: ["crossOrg", "brand"],
  audience: ["crossOrg", "brand", "campaign"],
};
const NUMBER_GRAINS: GrainName[] = ["audience", "campaign", "brand", "crossOrg"];

/** Per-grain vendor-basis statement, added to every grain block of the actual-cost body. */
export interface GrainVendorStatement {
  /** Vendor cost of this grain's PRICED rows. Always a number — the part we do know, never the whole
   *  when `unpricedBilledCostUsd` > 0. */
  pricedVendorCostUsd: number;
  /** BILLED spend of this grain's rows with no known vendor cost. 0 when every row is priced. */
  unpricedBilledCostUsd: number;
  /** TRUE ⟺ this grain and every grain it floors against are fully priced, i.e. its money is real. */
  vendorCostKnown: boolean;
}

export type ActualCostProjectionRow = Omit<ProjectionRow, "estimatesByGrain" | "resolved"> & {
  estimatesByGrain: Partial<Record<GrainName, Record<string, unknown> & { vendorCost: GrainVendorStatement }>>;
  resolved: ProjectionRow["resolved"] & { vendorCostKnown: boolean };
};

const rowKey = (r: ProjectionRow) => `${r.audienceId ?? ""}|${r.workflow.workflowDynastySlug}`;

function nullMoney(block: Record<string, unknown>): Record<string, unknown> {
  const evidence = block.evidence as Record<string, unknown>;
  const unitCosts = block.unitCosts as Record<string, unknown>;
  const projected = block.projected as Record<string, unknown>;
  const legOutcome = block.legOutcome as Record<string, unknown> | undefined;
  return {
    ...block,
    evidence: { ...evidence, spentUsd: null },
    unitCosts: Object.fromEntries(Object.keys(unitCosts).map((k) => [k, null])),
    projected: Object.fromEntries(Object.keys(projected).map((k) => [k, null])),
    ...(legOutcome ? { legOutcome: { ...legOutcome, costPerOutcomeUsd: null, spentUsd: null } } : {}),
  };
}

const RESOLVED_MONEY = [
  "costPerClickUsd",
  "costPerOutcomeUsd",
  "costPerPaidClientUsd",
  "costPerMeetingBookedUsd",
  "roiMultiple",
  "cacPct",
] as const;

/**
 * Merge the three projections into the actual-cost body. PURE.
 *
 * `anyUnpriced` covers the rows that rest on no grain of their own (the EXPLORE ALLOWANCE, priced off
 * the channel's outreach price, which sums every grain's spend): their money is known only when
 * nothing in the evidence is unpriced.
 */
export function overlayVendorProjection(
  billed: WorkflowProjectionResponse,
  vendor: WorkflowProjectionResponse,
  unpriced: WorkflowProjectionResponse,
): Omit<WorkflowProjectionResponse, "rows"> & { rows: ActualCostProjectionRow[]; unpricedBilledCostUsd: number } {
  const vendorRows = new Map(vendor.rows.map((r) => [rowKey(r), r]));
  const unpricedRows = new Map(unpriced.rows.map((r) => [rowKey(r), r]));
  // Rows cover every grain's spend several times (one per audience); the fleet-wide total unpriced is
  // the largest grain any row states — the crossOrg grain carries the fleet's whole spend.
  let totalUnpriced = 0;
  for (const r of unpriced.rows) {
    for (const g of Object.values(r.estimatesByGrain)) totalUnpriced = Math.max(totalUnpriced, g?.evidence.spentUsd ?? 0);
  }
  const anyUnpriced = totalUnpriced > 0;

  const rows: ActualCostProjectionRow[] = billed.rows.map((b) => {
    const key = rowKey(b);
    const v = vendorRows.get(key);
    const u = unpricedRows.get(key);
    const unpricedOf = (g: GrainName) => u?.estimatesByGrain[g]?.evidence.spentUsd ?? 0;
    const grains = Object.keys(b.estimatesByGrain) as GrainName[];
    const ownPriced = (g: GrainName) => unpricedOf(g) === 0 && !!v?.estimatesByGrain[g];
    const known = (g: GrainName) => ownPriced(g) && PARENTS[g].every((p) => !b.estimatesByGrain[p] || ownPriced(p));

    const estimatesByGrain: ActualCostProjectionRow["estimatesByGrain"] = {};
    for (const g of grains) {
      const vendorBlock = v?.estimatesByGrain[g];
      const statement: GrainVendorStatement = {
        pricedVendorCostUsd: vendorBlock?.evidence.spentUsd ?? 0,
        unpricedBilledCostUsd: unpricedOf(g),
        vendorCostKnown: known(g),
      };
      // Counts come from the billed block (same rows, and present even where no vendor cost is).
      const base = (known(g) ? vendorBlock : b.estimatesByGrain[g]) as unknown as Record<string, unknown>;
      const { costBasis: _basis, ...rest } = base;
      void _basis;
      estimatesByGrain[g] = { ...(known(g) ? rest : nullMoney(rest)), vendorCost: statement };
    }

    // The resolved numbers come from the finest grain with spend; they are known only when that grain
    // is (which already requires every grain it floors against). A row resting on no grain at all is
    // the explore allowance (or all-null), priced off every grain's spend.
    const numberGrain = NUMBER_GRAINS.find((g) => b.estimatesByGrain[g]);
    const resolvedKnown = numberGrain ? known(numberGrain) : !anyUnpriced;
    const source = resolvedKnown && v ? v.resolved : b.resolved;
    const { costBasis: _rb, ...resolvedRest } = source;
    void _rb;
    const resolved = {
      ...resolvedRest,
      ...(resolvedKnown ? {} : Object.fromEntries(RESOLVED_MONEY.map((k) => [k, null]))),
      vendorCostKnown: resolvedKnown,
    } as ActualCostProjectionRow["resolved"];

    return { ...b, estimatesByGrain, resolved };
  });

  return {
    ...billed,
    rows,
    // A budget recommendation is a customer-facing billed figure; it has no vendor-cost meaning.
    recommendedBudgetUsd: null,
    unpricedBilledCostUsd: totalUnpriced,
  };
}
