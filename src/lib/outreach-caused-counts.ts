/**
 * THE PUBLIC SHOWCASE COUNTS ONLY WHAT OUR OUTREACH CAUSED, AS LEAD-SERVICE JUDGED IT (owner 2026-10-29,
 * SHOWCASE-OUR-WINS-1029).
 *
 * A client's own dashboard COUNTS every conversion and PRICES only ours (owner 2026-09-25, « price only
 * our wins, count every conversion »): a meeting their CRM booked before we ever wrote to that person is
 * still a meeting the client had. A public homepage card is a different statement: every figure on it
 * reads as what WE produced for that client. Doc Dinners' card read 149 meetings booked beside 29
 * positive replies; lead-service's own cause verdict gives 7 of them to our outreach.
 *
 * ONE SOURCE OF TRUTH: the producer's verdict. So the showcase walks the SAME persons the client's
 * dashboard does, then:
 *   - drops every rung a person reached only through an outcome not priced to our outreach
 *     (`unpricedSignals`, set from the producer's stored `causedByOutreach` by `lib/signal-overlays.ts`);
 *   - keeps a statement-backed rung (booked, attended, sale) ONLY when a lead-service statement PRICED
 *     it for that person. The legacy instantly qualifications carry no cause, and the dashboard judges
 *     them with this service's own copy of the delivery rule; that copy is never a public claim (prod
 *     2026-10-29: Doc Dinners read 8 meetings, the 8th an Instantly "meeting booked" mark 2 h after our
 *     first email to a person whose CRM booking, dated 2025-04-10, lead-service had withdrawn).
 * No brand is named. The engine pass (pipeline, return, cost) is untouched: only the COUNTS the showcase
 * prints are built from the stripped copy.
 */
import type { EnginePerson } from "./revenue-engine.js";
import { STATED_RUNG_SIGNALS, type ObservedLeadFacts } from "./observed-steps.js";

/**
 * A copy of each person carrying only the rungs the producer judged ours: every UNPRICED signal unset,
 * and every statement-backed rung no PRICED lead-service statement reached for that email unset (dates
 * dropped, `unpricedSignals` cleared). Never mutates.
 *
 * Applied per ROW, before any dedup: a lead whose one row priced the meeting and another did not still
 * reaches the meeting after the merge, the same "one row saying it was ours is enough" rule the dedup's
 * own `mergeUnpriced` applies.
 */
export function withOutreachCausedSignalsOnly(
  persons: readonly EnginePerson[],
  observed: ReadonlyMap<string, ObservedLeadFacts>,
): EnginePerson[] {
  return persons.map((p) => {
    const facts = p.email ? observed.get(p.email) : undefined;
    const drop = new Set(p.unpricedSignals ?? []);
    for (const signal of STATED_RUNG_SIGNALS) {
      if (!p.signals[signal]) continue;
      const statedOurs = facts !== undefined && signal in facts.reached && !facts.unpricedSignals.includes(signal);
      if (!statedOurs) drop.add(signal);
    }
    if (drop.size === 0) return p;
    const signals = { ...p.signals };
    const signalDates = p.signalDates ? { ...p.signalDates } : p.signalDates;
    for (const signal of drop) {
      signals[signal] = false;
      if (signalDates) delete signalDates[signal];
    }
    return { ...p, signals, signalDates, unpricedSignals: undefined };
  });
}
