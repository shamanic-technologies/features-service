/**
 * LEDGER-ONLY-1107-P2: a funnel campaign's activity (its funnel steps, each pipe's work and calls) re-based on the general
 * ledger. PURE. A step's count = the Units its units' runs produced of that outcome (`ledgerCountOfStep`); a pipe's
 * `reached` = the Units ITS campaign produced of its `to` step, per day; a booking call obtained = the `booking_call`
 * Units. What is no catalogue outcome (people contacted / sent / delivered / handed / acted on, calls placed) is served
 * null + `not_a_ledger_outcome`; an outcome the ledger lacks is null + its reason. Rates are Units ÷ Units.
 * The milestones and people-journeys reads compose this body, so they follow.
 */
import { ledgerCountOfStep, NOT_A_LEDGER_OUTCOME, type LedgerScope } from "./ledger-counts.js";

type Obj = Record<string, unknown>;
const pct = (n: number | null, d: number | null) => (n === null || d === null || d <= 0 ? null : Math.round((n / d) * 10000) / 100);

interface StepLike {
  key: string;
  kind: "step" | "outreach";
  people: number | null;
  rateToNextPct: number | null;
  unmeasuredReason: string | null;
}

/** PURE. The activity body on the ledger: `scope` = all its units' campaigns, `pipeScope(campaignId)` = one unit's. */
export function withLedgerActivity<T extends object>(input: T, scope: LedgerScope, pipeScope: (campaignId: string) => LedgerScope): T {
  const body = input as unknown as { funnel: { steps: StepLike[] } | null; pipes: Obj[] };
  const steps = body.funnel?.steps.map((s): StepLike => {
    if (s.kind !== "step") return { ...s, people: null, rateToNextPct: null, unmeasuredReason: NOT_A_LEDGER_OUTCOME };
    const c = ledgerCountOfStep(scope, s.key);
    return { ...s, people: c.units, rateToNextPct: null, unmeasuredReason: c.units === null ? c.reason : null };
  });
  if (steps) for (let i = 0; i < steps.length - 1; i++) steps[i] = { ...steps[i]!, rateToNextPct: pct(steps[i + 1]!.people, steps[i]!.people) };

  const pipes = body.pipes.map((p) => {
    const toStep = (p.toStep as string | null) ?? null;
    const own = pipeScope(String(p.campaignId));
    const reached = toStep === null ? null : ledgerCountOfStep(own, toStep);
    const out: Obj = { ...p };
    if (p.people) out.people = { found: null, contacted: null, sent: null, delivered: null, reachedToStep: reached?.units ?? null, unavailableReason: NOT_A_LEDGER_OUTCOME };
    if (p.work) {
      const daily = (reached?.row?.past ?? []).filter((d) => d.units > 0).map((d) => ({ date: d.date, handed: null, actedOn: null, reached: d.units }));
      out.work = { handed: null, actedOn: null, reached: reached?.units ?? null, conversionRatePct: null, daily, undated: { handed: null, actedOn: null, reached: 0 }, unavailableReason: NOT_A_LEDGER_OUTCOME };
    }
    if (p.calls) {
      const calls = p.calls as Obj & { totals?: Obj; spend?: Obj | null };
      const booked = ledgerCountOfStep(own, "booking_call");
      const committed = (calls.spend?.committedUsd as number | undefined) ?? null;
      out.calls = {
        ...calls,
        totals: { ...(calls.totals ?? {}), requested: null, placed: null, accepted: null, connected: booked.units, outcomes: null },
        daily: (booked.row?.past ?? []).filter((d) => d.units > 0).map((d) => ({ day: d.date, requested: null, placed: null, accepted: null, connected: d.units, outcomes: null })),
        spend: calls.spend ? { ...calls.spend, costPerPlacedCallUsd: null, costPerConnectedCallUsd: committed !== null && booked.units ? Math.round((committed / booked.units) * 100) / 100 : null } : calls.spend,
        ledgerUnavailableReason: booked.units === null ? booked.reason : null,
      };
    }
    return out;
  });
  return { ...(input as Obj), basis: "ledger_units_since_inception", funnel: body.funnel && steps ? { ...body.funnel, steps } : body.funnel, pipes } as unknown as T;
}
