/**
 * WHOSE WIN AN OUTCOME WAS — `?cause=`, and the three states it is read in.
 *
 * A brand contacts people through us and also through everything else it already does: referrals,
 * conferences, an existing pipeline, another agency. So some of the people we email go on to buy for
 * reasons that have nothing to do with our outreach, and until lead-service#511 nobody could say so —
 * the value of those deals landed in the same place as the value of the deals we produced, and every
 * return this service reported on our own outreach was too good by however much of it we did not
 * cause.
 *
 * The customer can now say so, per statement, and lead-service exposes the answer on the two reads
 * this service already consumes: `causedByOutreach` per row on `/converted-leads`, and
 * `byCause.outreach|other|unstated` on `/conversion-counts`. This module holds the vocabulary and
 * NOTHING else, so the producer's three words stay the fleet's three words.
 *
 * ── THE THREE STATES, AND WHY THE THIRD IS NOT A MISSING ANSWER ─────────────────────────────────
 *
 *   - `outreach` — the customer states OUR outreach caused it.
 *   - `other`    — they state something else of theirs did. The deal is REAL: it stays in their own
 *                  counts, their own revenue and their own ledger, and saying so honestly costs them
 *                  nothing they can see. What the answer buys is leaving its value out of the return
 *                  computed on OUR outreach.
 *   - `unstated` — UNDECIDED. Nobody answered, and lead-service's default rule could not either:
 *                  the outcome is undated, not matched to a lead, or on a lead we never delivered to.
 *                  (A DATED outcome on a lead we emailed gets the rule's answer, whatever its source.)
 *                  It is never folded into `other`; it is simply not claimed as ours.
 *
 * Deliberately NOT the tracker's `attributed / needs_review / unmatched` vocabulary, which answers a
 * different question (did we manage to identify who somebody was); lead-service kept the two apart
 * and so does this.
 *
 * ── `?cause=` SAYS WHICH OUTCOMES ARE PRICED, AND EVERY OUTCOME IS STILL COUNTED ───────────────
 *
 * (Supersedes the "every state, byte-identical to today" default of features-service#882.) Owner,
 * 2026-09-25: the conversions a brand sees must be ALL of them, while the ROI of OUR service counts
 * only what we generated. So the parameter moved from filtering the outcome to filtering its VALUE:
 * an outcome whose state is not priced still reaches its rung in `leads[]`, `funnelSteps` and every
 * measured conversion rate, and adds nothing to the pipeline, the return or the cost of acquisition.
 *
 * The DEFAULT is `outreach` alone — the same default the user dashboard shows on a lead's right panel
 * ("Ours" / "Not ours" / "Undecided", with "Undecided" reading "we do not claim it"). lead-service
 * answers `outreach` for any dated outcome that followed our first delivered email to that person, so
 * the default counts exactly what the panel calls ours. `unstated` is priced only when a caller names
 * it: an outcome nobody could date against our outreach is not claimed.
 */

/** The producer's three words, in the canonical order every echo and every cache key uses. */
export const OUTCOME_CAUSES = ["outreach", "other", "unstated"] as const;
export type OutcomeCause = (typeof OUTCOME_CAUSES)[number];

/** Every state. */
export const ALL_OUTCOME_CAUSES: readonly OutcomeCause[] = OUTCOME_CAUSES;

/** The states PRICED when a caller names none: our own wins only. */
export const DEFAULT_PRICED_CAUSES: readonly OutcomeCause[] = ["outreach"];

/**
 * WHOSE WIN a LEGACY outcome was — lead-service's default rule (crm-evidence `crmCauseRule`), applied
 * to the one producer lead-service does not hold: the instantly manual qualifications, which carry no
 * cause and never can (that source is closed; nobody writes to it any more). Same inputs, same
 * answers: after our first delivered email to that person → ours; before → not ours; undated, or
 * nothing delivered → undecided. Kept identical to the producer's rule on purpose so a legacy meeting
 * and a stated one are judged the same way; it empties itself as the legacy rows are restated.
 */
export function causeByDeliveryRule(
  occurredAt: string | null | undefined,
  firstDeliveredAt: string | null | undefined,
): OutcomeCause {
  const event = occurredAt ? Date.parse(occurredAt) : NaN;
  const delivered = firstDeliveredAt ? Date.parse(firstDeliveredAt) : NaN;
  if (Number.isNaN(event) || Number.isNaN(delivered)) return "unstated";
  return event > delivered ? "outreach" : "other";
}

/**
 * WHICH STATE one outcome is in, from the producer's per-row `causedByOutreach`.
 *
 * `null` (and anything that is not a boolean, which is what a producer predating the field sends) is
 * `unstated` — never coerced to either answer, which is the whole point of the third state.
 */
export function causeOf(causedByOutreach: boolean | null | undefined): OutcomeCause {
  if (causedByOutreach === true) return "outreach";
  if (causedByOutreach === false) return "other";
  return "unstated";
}

/**
 * Parse `?cause=` — a comma-separated set of the three words, in any order and any case, naming the
 * states whose outcomes are PRICED.
 *
 * Absent / empty → `outreach` alone (the default). An unrecognised word, or a list that names no state at
 * all, is `null` → the caller 400s: silently counting a set the caller did not ask for is exactly the
 * misunderstanding this parameter exists to remove, and "count nothing" is not a question anyone means.
 */
export function parseOutcomeCauses(raw: unknown): readonly OutcomeCause[] | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PRICED_CAUSES;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_PRICED_CAUSES;

  const seen = new Set<OutcomeCause>();
  for (const part of trimmed.split(",")) {
    const word = part.trim().toLowerCase();
    if (word === "") continue;
    if (!(OUTCOME_CAUSES as readonly string[]).includes(word)) return null;
    seen.add(word as OutcomeCause);
  }
  if (seen.size === 0) return null;
  // Canonical order, so `outreach,unstated` and `unstated,outreach` are ONE cache cell and ONE echo.
  return OUTCOME_CAUSES.filter((c) => seen.has(c));
}

/**
 * The canonical cache-key form. Always present: the default moved (every state → `outreach`), so a
 * snapshot keyed without it is a body priced on the old default and must never be served again.
 */
export function causeScopeKeyPart(causes: readonly OutcomeCause[]): string {
  return `priced:${causes.join("+")}`;
}

/** A zeroed tally, one entry per state. */
export function zeroCauseTally<T>(zero: () => T): Record<OutcomeCause, T> {
  return {
    outreach: zero(),
    other: zero(),
    unstated: zero(),
  };
}
