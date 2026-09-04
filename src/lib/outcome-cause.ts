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
 *   - `unstated` — NOBODY WAS ASKED. Every statement made before the field existed, and every
 *                  tracker-reported outcome, because a page-load tag observes a page load and cannot
 *                  know why somebody bought. It is neither of the other two answers and is never
 *                  folded into either: reading it as ours is exactly today's overstatement, and
 *                  reading it as theirs would wipe out the measured pipeline of every brand on the
 *                  platform overnight, since almost every outcome in the system is in this state.
 *
 * So the CALLER says which states it counts, one word per state, and nothing is decided silently.
 * Deliberately NOT the tracker's `attributed / needs_review / unmatched` vocabulary, which answers a
 * different question (did we manage to identify who somebody was); lead-service kept the two apart
 * and so does this.
 *
 * ── THE DEFAULT IS EVERY STATE, AND IT IS BYTE-IDENTICAL TO TODAY ───────────────────────────────
 *
 * A read that names nothing counts all three, which is what this service has always counted. A
 * consumer that never asks reads exactly what it read before, at every grain.
 */

/** The producer's three words, in the canonical order every echo and every cache key uses. */
export const OUTCOME_CAUSES = ["outreach", "other", "unstated"] as const;
export type OutcomeCause = (typeof OUTCOME_CAUSES)[number];

/** Every state — the DEFAULT, i.e. what this service counted before `?cause=` existed. */
export const ALL_OUTCOME_CAUSES: readonly OutcomeCause[] = OUTCOME_CAUSES;

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
 * Parse `?cause=` — a comma-separated set of the three words, in any order and any case.
 *
 * Absent / empty → every state (the default). An unrecognised word, or a list that names no state at
 * all, is `null` → the caller 400s: silently counting a set the caller did not ask for is exactly the
 * misunderstanding this parameter exists to remove, and "count nothing" is not a question anyone means.
 */
export function parseOutcomeCauses(raw: unknown): readonly OutcomeCause[] | null {
  if (raw === undefined || raw === null || raw === "") return ALL_OUTCOME_CAUSES;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return ALL_OUTCOME_CAUSES;

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

/** The canonical cache-key / echo form. `undefined` for the default set, so today's keys are unmoved. */
export function causeScopeKeyPart(causes: readonly OutcomeCause[]): string | undefined {
  if (causes.length === OUTCOME_CAUSES.length) return undefined;
  return causes.join("+");
}

/** A zeroed tally, one entry per state. */
export function zeroCauseTally<T>(zero: () => T): Record<OutcomeCause, T> {
  return {
    outreach: zero(),
    other: zero(),
    unstated: zero(),
  };
}
