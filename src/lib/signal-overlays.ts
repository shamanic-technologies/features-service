/**
 * The two SECONDARY per-lead overlays every revenue grain merges onto its persons, in ONE place.
 *
 *   - the per-event timestamps (email-gateway) — the dates the time-series / events ledger / the
 *     per-lead date columns are built from, plus the `open` signal, which has no boolean on the lead
 *     row at all: a known open timestamp IS the signal.
 *   - the manual qualifications (instantly-service) — the meeting-booked / closed-won dates, which
 *     ARE those two signals for the same reason.
 *
 * Extracted verbatim from `computeFeatureRevenue`'s two inline loops so the brand / campaign grain and
 * the per-workflow grain merge the identical overlays in the identical order. Both grains price the
 * same leads through the same funnel, so a second copy of this merge is exactly how two grains come to
 * disagree about whether a lead ever opened. PURE — the reads stay with their callers, which decide
 * their own fail-soft posture.
 */
import type { EnginePerson } from "./revenue-engine.js";
import type { SignalDates } from "./email-status-client.js";
import type { QualificationDates } from "./qualifications-client.js";

export function applySignalOverlays(
  persons: EnginePerson[],
  // null = that read degraded (its caller logged loudly); the overlay is skipped rather than faked.
  timestamps: Map<string, SignalDates> | null,
  quals: Map<string, QualificationDates> | null,
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

  if (quals) {
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
}
