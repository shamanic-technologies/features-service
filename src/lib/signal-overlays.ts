/**
 * The two SECONDARY per-lead overlays every revenue grain merges onto its persons, in ONE place.
 *
 *   - the per-event timestamps (email-gateway) — the dates the time-series / events ledger / the
 *     per-lead date columns are built from, plus the `open` signal, which has no boolean on the lead
 *     row at all: a known open timestamp IS the signal.
 *   - what a HUMAN OBSERVED about the lead — the rung it stands on, what the deal was worth, and which
 *     steps have been ruled out for it. TWO producers answer that today and their order is the whole
 *     contract: the instantly manual qualifications are the LEGACY source (they carry 4 booked meetings
 *     and 4 closed deals in production, measured facts that must not vanish), and lead-service's step
 *     statements are the one being written to from now on, so a statement WINS wherever it exists.
 *
 *     This is a migration, not two truths: the same `COALESCE(new, legacy)` shape the frozen-net cost
 *     read uses. It empties itself as the statements move over, and until then dropping the legacy half
 *     would erase real outcomes from live brands' pipelines — which is a worse answer than a second
 *     read that is losing rows every week.
 *
 * Extracted verbatim from `computeFeatureRevenue`'s two inline loops so the brand / campaign grain and
 * the per-workflow grain merge the identical overlays in the identical order. Both grains price the
 * same leads through the same funnel, so a second copy of this merge is exactly how two grains come to
 * disagree about whether a lead ever opened. PURE — the reads stay with their callers, which decide
 * their own fail-soft posture.
 */
import type { EnginePerson } from "./revenue-engine.js";
import type { SignalDates } from "./email-status-client.js";
import type { ObservedLeadFacts } from "./observed-steps.js";
import type { QualificationDates } from "./qualifications-client.js";
import { deadLegSignalsFor } from "./funnel-registry.js";
import type { SalesFunnelKey } from "./sales-funnels-client.js";
import { ALL_OUTCOME_CAUSES, type OutcomeCause } from "./outcome-cause.js";

export function applySignalOverlays(
  persons: EnginePerson[],
  // null = that read degraded (its caller logged loudly); the overlay is skipped rather than faked.
  timestamps: Map<string, SignalDates> | null,
  observed: Map<string, ObservedLeadFacts> | null,
  /**
   * The LEGACY meeting-booked / closed dates (instantly manual qualifications). Applied FIRST, so a
   * lead-service statement about the same rung overwrites it — the statement is the source we write
   * to now, and the older one only fills what nobody has restated yet.
   */
  quals: Map<string, QualificationDates> | null = null,
  /**
   * The funnels this read prices on. A `never` kills the FUNNELS that contain the dead step, not the
   * step alone, so the expansion needs to know which funnels are in play — a brand that also sells a
   * funnel the dead step is not on keeps that funnel's value for the lead.
   */
  pricedFunnelKeys: readonly SalesFunnelKey[] = [],
  /**
   * WHICH CAUSE STATES this read counts (`lib/outcome-cause.ts`). The statement half is already
   * filtered at the row by `fetchObservedStepFacts`; what this decides is the LEGACY half. An
   * instantly manual qualification carries no cause and never can — nobody was ever asked about one —
   * so it is `unstated`, and a read that is not counting that state must not take a booked meeting or
   * a closed deal from it either. Anything else would leave one producer filtered and the other not,
   * which is two answers to one question inside a single body.
   */
  countedCauses: readonly OutcomeCause[] = ALL_OUTCOME_CAUSES,
): void {
  if (timestamps) {
    for (const person of persons) {
      const dates = person.email ? timestamps.get(person.email) : undefined;
      if (dates) {
        person.signalDates = {
          contacted: dates.contacted,
          sent: dates.sent,
          delivered: dates.delivered,
          open: dates.open,
          clicked: dates.clicked,
          positiveReply: dates.positiveReply,
        };
        // `open` has no boolean in the leads overlay — a known open timestamp IS the signal.
        if (dates.open) person.signals.open = true;
      }
    }
  }

  if (quals && countedCauses.includes("unstated")) {
    for (const person of persons) {
      const q = person.email ? quals.get(person.email) : undefined;
      if (!q) continue;
      person.signalDates = person.signalDates ?? {};
      if (q.meetingBookedAt) {
        person.signals.meeting = true;
        person.signalDates.meeting = q.meetingBookedAt;
      }
      if (q.closedAt) {
        person.signals.closeWin = true;
        person.signalDates.closeWin = q.closedAt;
      }
    }
  }

  if (observed) {
    for (const person of persons) {
      const facts = person.email ? observed.get(person.email) : undefined;
      if (!facts) continue;
      person.signalDates = person.signalDates ?? {};
      // A rung a human stated the lead reached. The date may legitimately be null (an undated
      // statement): the rung is still reached, it simply cannot be placed on the timeline — which is
      // the honest answer, and the reason it is never back-filled with the day we heard about it.
      for (const [signal, date] of Object.entries(facts.reached)) {
        person.signals[signal] = true;
        person.signalDates[signal] = date;
      }
      if (facts.valueUsd !== null) person.valueUsd = facts.valueUsd;
      if (facts.deadStepSignals.length > 0) {
        person.deadSignals = [...deadLegSignalsFor(facts.deadStepSignals, pricedFunnelKeys)];
      }
    }
  }
}
