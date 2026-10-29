/**
 * THE PUBLIC SHOWCASE COUNTS ONLY WHAT OUR OUTREACH CAUSED (owner 2026-10-29, SHOWCASE-OUR-WINS-1029).
 *
 * A client's own dashboard COUNTS every conversion and PRICES only ours (owner 2026-09-25, « price only
 * our wins, count every conversion »): a meeting their CRM booked before we ever wrote to that person is
 * still a meeting the client had. A public homepage card is a different statement: every figure on it
 * reads as what WE produced for that client. Doc Dinners' card read 149 meetings booked beside 29
 * positive replies, of which lead-service's own cause verdict gave 7 to our outreach (130 people we
 * never emailed, 11 who booked before our first email to them).
 *
 * So the showcase walks the SAME persons the client's dashboard does, then drops every rung a person
 * reached only through an outcome that is not priced to our outreach (`unpricedSignals`, set from the
 * producer's stored `causedByOutreach` verdict by `lib/signal-overlays.ts`). The verdict is READ, never
 * re-derived here; no brand is named. The engine pass (pipeline, return, cost) is untouched: only the
 * COUNTS the showcase prints are built from the stripped copy.
 */
import type { EnginePerson } from "./revenue-engine.js";

/**
 * A copy of each person with every UNPRICED signal (reached, but not our win) unset, its date dropped,
 * and `unpricedSignals` cleared. A person with no unpriced signal is returned as is. Never mutates.
 *
 * Applied per ROW, before any dedup: a lead whose one row priced the meeting and another did not still
 * reaches the meeting after the merge, the same "one row saying it was ours is enough" rule the
 * dedup's own `mergeUnpriced` applies.
 */
export function withOutreachCausedSignalsOnly(persons: readonly EnginePerson[]): EnginePerson[] {
  return persons.map((p) => {
    const unpriced = p.unpricedSignals ?? [];
    if (unpriced.length === 0) return p;
    const signals = { ...p.signals };
    const signalDates = p.signalDates ? { ...p.signalDates } : p.signalDates;
    for (const signal of unpriced) {
      signals[signal] = false;
      if (signalDates) delete signalDates[signal];
    }
    return { ...p, signals, signalDates, unpricedSignals: undefined };
  });
}
