/**
 * LEDGER-ONLY-1107-P2: `/audience-stats` (feature, brand, offer) on the general ledger. PURE.
 * Each audience's outcome counts = the ledger Units of runs served under it (runs-service `audienceId`), its $ / outcome
 * = its spend ÷ those Units. Contacted / opened are no outcome (null). An outcome the brand's ledger lacks is null + the
 * ledger's reason for every audience. The flash / mature person figures (`maturity` blocks) are no ledger figure (null);
 * the projection and the expected return are expected figures, untouched.
 */
import { ledgerCountOfStep, ledgerKeysOfStep, NOT_A_LEDGER_OUTCOME, type LedgerScope } from "./ledger-counts.js";

type Obj = Record<string, unknown>;
const EVIDENCE: Array<{ field: string; step: string; cost: string | null }> = [
  { field: "websiteClicks", step: "website_visit", cost: "cpcCents" },
  { field: "positiveReplies", step: "conversation", cost: "cpprCents" },
  { field: "formSubmissions", step: "form_submitted", cost: "cpfsCents" },
  { field: "signups", step: "signup", cost: "cpsCents" },
  { field: "sales", step: "paid_client", cost: "cpsaleCents" },
];

export function withLedgerAudienceStats<T extends object>(input: T, brand: LedgerScope, byAudience: ReadonlyMap<string, ReadonlyMap<string, number>> | null): T {
  const body = input as unknown as Obj;
  const audiences = ((body.audiences as Obj[] | undefined) ?? []).map((a) => {
    const units = byAudience?.get(String(a.audienceId)) ?? new Map<string, number>();
    const ev: Obj = { ...((a.evidence as Obj) ?? {}), contacted: null, opened: null };
    const metrics: Obj = { ...((a.metrics as Obj) ?? {}), maturity: null };
    const reasons: Record<string, string> = { contacted: NOT_A_LEDGER_OUTCOME, opened: NOT_A_LEDGER_OUTCOME };
    for (const e of EVIDENCE) {
      const brandRow = ledgerCountOfStep(brand, e.step);
      const n = brandRow.units === null || byAudience === null ? null : ledgerKeysOfStep(e.step).reduce((s, k) => s + (units.get(k) ?? 0), 0);
      if (n === null) reasons[e.field] = brandRow.reason ?? "ledger_unreadable";
      ev[e.field] = n;
      const spent = ev.totalCostInUsdCents as number | undefined;
      if (e.cost && e.cost in metrics) metrics[e.cost] = n !== null && n > 0 && spent ? spent / n : null;
    }
    const projection = a.projection ? { ...(a.projection as Obj), maturity: null } : a.projection;
    return { ...a, evidence: ev, metrics, projection, maturity: null, ledgerUnavailableReasons: reasons };
  });
  const bp = body.brandProjection as Obj | null | undefined;
  return {
    ...body,
    audiences,
    brandProjection: bp ? { ...bp, maturity: null } : bp,
    maturity: null,
    unattributedMaturity: null,
    ledgerCounts: { basis: "ledger", scope: "audience", unavailableReason: brand.unavailableReason ?? (byAudience === null ? "ledger_unreadable" : null), ledgerDaysMissing: [...(brand.ledger?.daysMissing ?? [])] },
  } as unknown as T;
}
