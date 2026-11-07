/**
 * LEDGER-ONLY-1107-P2: `/offers/:offerId/outcomes` on the general ledger. PURE.
 *  - each outcome row: count = the BRAND's ledger Units of the step (Today's count), each leg's = the Units its own
 *    campaigns' runs produced; $ / outcome = the row's spend ÷ those Units; value = Units × value per outcome.
 *  - the pipeline ladder: each step's count = the brand's ledger Units; customers won = the ledger's Paid client Units.
 *  - figures counting PEOPLE (contacted, companies, conversion between steps, the exclusive ladder's people per row, its
 *    conversion and history, the flash / mature pair) have no ledger twin: null + `not_a_ledger_outcome`.
 * The lists of leads (hot, cold, lost, people per step) are records, not figures: untouched.
 */
import { ledgerCountOfStep, NOT_A_LEDGER_OUTCOME, type LedgerScope } from "./ledger-counts.js";

type Obj = Record<string, unknown>;
const r2 = (v: number) => Math.round(v * 100) / 100;
const per = (usd: unknown, n: number | null) => (typeof usd !== "number" || n === null || n <= 0 || usd <= 0 ? null : r2(usd / n));
const times = (v: unknown, n: number | null) => (typeof v !== "number" || n === null ? null : r2(v * n));

function figures(row: Obj, scope: LedgerScope, step: string): Obj {
  const c = ledgerCountOfStep(scope, step);
  return {
    ...row,
    recipientsReached: c.units,
    costPerOutcomeUsd: per(row.spentUsd, c.units),
    valueUsd: times(row.valuePerOutcomeUsd, c.units),
    unmeasuredReason: c.units === null ? c.reason : row.unmeasuredReason ?? null,
    producerGap: c.producerGap,
    maturity: null,
  };
}

export function withLedgerOfferOutcomes<T extends object>(input: T, brand: LedgerScope, campaignsScope: (campaignIds: readonly string[]) => LedgerScope): T {
  const body = input as unknown as Obj;
  const out: Obj = { ...body };
  out.outcomes = ((body.outcomes as Obj[] | undefined) ?? []).map((row) => {
    const step = (row.step as { key: string }).key;
    const legs = ((row.legs as Obj[] | undefined) ?? []).map((leg) => ({ ...figures(leg, campaignsScope((leg.campaignIds as string[]) ?? []), (leg.toStep as { key: string }).key), countBasis: "ledger_units" }));
    return { ...figures(row, brand, step), conversionFromPrevious: null, legs };
  });
  const p = body.pipeline as Obj | undefined;
  if (p) {
    const ladder = ((p.ladder as Obj[] | undefined) ?? []).map((s) => {
      const c = ledgerCountOfStep(brand, (s.step as { key: string }).key);
      return { ...s, recipientsReached: c.units, pricedRecipientsReached: c.units, pricedValueUsd: times(s.valuePerOutcomeUsd, c.units), conversionFromPrevious: null, pricedConversionFromPrevious: null, unmeasuredReason: c.units === null ? c.reason : null };
    });
    const paid = ledgerCountOfStep(brand, "paid_client");
    const cw = p.customersWon as Obj | null | undefined;
    const ex = p.exclusiveLadder as Obj | undefined;
    out.pipeline = {
      ...p,
      peopleContacted: null,
      companiesContacted: null,
      contactedWithoutCompanyCount: null,
      ladder,
      customersWon: cw ? { ...cw, count: paid.units, leadCount: null, valueUsd: null, otherCausesLeadCount: null, unavailableReason: paid.units === null ? paid.reason : null } : cw,
      exclusiveLadder: ex
        ? {
            ...ex,
            contacted: { ...(ex.contacted as Obj), count: null, conversionFromRowAbove: null, expectedConversionFromRowAbove: (ex.contacted as Obj)?.expectedConversionFromRowAbove },
            rows: ((ex.rows as Obj[] | undefined) ?? []).map((r) => ({ ...r, pricedPeople: null, conversionFromRowAbove: null, conversionHistory: null })),
            total: { ...(ex.total as Obj), people: null, peopleOnNoRow: null },
            unavailableReason: NOT_A_LEDGER_OUTCOME,
          }
        : ex,
    };
  }
  out.ledgerCounts = { basis: "ledger", scope: "brand", unavailableReason: brand.unavailableReason, peopleFields: NOT_A_LEDGER_OUTCOME, ledgerDaysMissing: [...(brand.ledger?.daysMissing ?? [])] };
  return out as T;
}
