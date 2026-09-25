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
import { DEFAULT_PRICED_CAUSES, causeByDeliveryRule, type OutcomeCause } from "./outcome-cause.js";

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
   * WHICH CAUSE STATES this read PRICES (`lib/outcome-cause.ts`); every state is still counted. The
   * statement half arrives already marked by `fetchObservedStepFacts`; what this decides is the
   * LEGACY half. An instantly manual qualification carries no cause, so it is judged by lead-service's
   * own default rule (`causeByDeliveryRule`) against our first delivered email to that person — the
   * same rule every other outcome gets, so one producer is never priced on a looser rule than the other.
   */
  pricedCauses: readonly OutcomeCause[] = DEFAULT_PRICED_CAUSES,
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
          // A reply known ONLY from the customer's CRM is dated by the CRM (leads-client): the sender's
          // first-reply timestamp would be a reply it did NOT classify positive.
          positiveReply: person.crmPositiveReplyAt ?? dates.positiveReply,
        };
        // `open` has no boolean in the leads overlay — a known open timestamp IS the signal.
        if (dates.open) person.signals.open = true;
      }
    }
  }

  if (quals) {
    for (const person of persons) {
      const q = person.email ? quals.get(person.email) : undefined;
      if (!q) continue;
      person.signalDates = person.signalDates ?? {};
      // Delivery date read BEFORE this overlay writes anything: the rule compares against OUR email.
      const deliveredAt = person.signalDates.delivered ?? null;
      const legacy: Array<[string, string]> = [];
      if (q.meetingBookedAt) legacy.push(["meeting", q.meetingBookedAt]);
      if (q.closedAt) legacy.push(["closeWin", q.closedAt]);
      for (const [signal, at] of legacy) {
        person.signals[signal] = true;
        person.signalDates[signal] = at;
        setPriced(person, signal, pricedCauses.includes(causeByDeliveryRule(at, deliveredAt)));
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
      // A statement about a rung supersedes the legacy answer about it — its cause included.
      for (const [signal, date] of Object.entries(facts.reached)) {
        person.signals[signal] = true;
        person.signalDates[signal] = date;
        setPriced(person, signal, !facts.unpricedSignals.includes(signal));
      }
      // Website conversions: the rung is set elsewhere, the cause rides the statement rows.
      for (const signal of facts.unpricedSignals) {
        if (!(signal in facts.reached)) setPriced(person, signal, false);
      }
      if (facts.valueUsd !== null) person.valueUsd = facts.valueUsd;
      if (facts.deadStepSignals.length > 0) {
        person.deadSignals = [...deadLegSignalsFor(facts.deadStepSignals, pricedFunnelKeys)];
      }
    }
  }
}

function setPriced(person: EnginePerson, signal: string, priced: boolean): void {
  const current = new Set(person.unpricedSignals ?? []);
  if (priced) current.delete(signal);
  else current.add(signal);
  person.unpricedSignals = current.size > 0 ? [...current] : undefined;
}

