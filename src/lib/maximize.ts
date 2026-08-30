/**
 * WHAT A CALLER IS TRYING TO MAXIMISE — a RETURN, or a CONVERSION RATE.
 *
 * Every recommendation this service makes ranks the same catalogue of workflows, and until now it
 * ranked it exactly one way: cheapest cost per outcome, i.e. the most outcome per dollar. That is the
 * right answer while the pool of people to reach is effectively unbounded, because then the binding
 * constraint is the customer's BUDGET and the thing worth maximising is what each dollar buys.
 *
 * It is the wrong answer when the pool is small and finite. A niche list will be exhausted, so the
 * binding constraint is the INVENTORY rather than the money: burning fewer people per outcome matters
 * more than what each outcome costs, and the thing worth maximising is the CONVERSION RATE. The same
 * catalogue ranks differently under the two, and a caller that cannot say which one it means gets the
 * budget answer whether or not that is its problem.
 *
 * ── IT IS A PARAMETER OF THE QUESTION, NEVER A PROPERTY OF A BRAND ────────────────────────────────
 *
 * One brand asks both questions — of two channels, of two legs, of the same leg on two days — so this
 * is never read from a brand's configuration and never stored. It arrives on the request, it is stated
 * back on the response, and nothing here defaults it from anything but the absence of the parameter.
 *
 * ── THE WORD IS NOT `objective` ───────────────────────────────────────────────────────────────────
 *
 * `objective` is already taken on these endpoints: it is the deprecated alias of the GOAL — the kind of
 * OUTCOME being priced (a signup, a booked meeting) — and it must keep meaning that until every caller
 * has moved off it. What is maximised and what outcome is being bought are two different questions, so
 * they get two different words rather than one word that answers whichever the reader assumed.
 */

/** The two things a caller can ask to maximise. There is no third one, and there must not be. */
export type Maximize = "return" | "conversionRate";

/** The vocabulary, in the canonical spelling the response echoes back. */
export const MAXIMIZE_VALUES: Maximize[] = ["return", "conversionRate"];

/**
 * The default, and it is the ONLY behaviour that existed before this: a caller that says nothing is
 * asking what it has always been asking, and reads a byte-identical ranking.
 */
export const DEFAULT_MAXIMIZE: Maximize = "return";

const BY_NORMALISED: Map<string, Maximize> = new Map([
  ["return", "return"],
  ["returnperdollar", "return"],
  ["conversionrate", "conversionRate"],
  ["conversion", "conversionRate"],
]);

/**
 * Resolve a caller's spelling, tolerating the case and separator variance every other vocabulary here
 * tolerates (`conversion_rate` / `conversion-rate` / `conversionRate`). `null` for a word naming
 * neither — every caller FAILS LOUD on that rather than falling back to the default, because silently
 * ranking on return a caller that asked for something else is the whole failure this exists to prevent.
 */
export function matchMaximize(raw: string): Maximize | null {
  const normalised = raw.trim().toLowerCase().replace(/[\s\-_]+/g, "");
  return BY_NORMALISED.get(normalised) ?? null;
}

/**
 * Read the parameter off a query object. Accepts BOTH spellings of the key (`maximize` / `maximise`)
 * because the value is what carries the meaning and a British caller should not read a 400.
 *
 *  - absent / empty  → `{ ok: true, maximize: "return" }` — today's behaviour, unchanged.
 *  - a known word    → that one.
 *  - anything else   → `{ ok: false }`, and the route 400s naming the vocabulary.
 */
export function parseMaximize(query: Record<string, unknown>): { ok: true; maximize: Maximize } | { ok: false } {
  const raw = (query.maximize ?? query.maximise) as string | undefined;
  if (raw == null || raw === "") return { ok: true, maximize: DEFAULT_MAXIMIZE };
  const matched = matchMaximize(raw);
  return matched ? { ok: true, maximize: matched } : { ok: false };
}

/** The 400 body's message, one spelling of the vocabulary shared by every route that takes it. */
export const MAXIMIZE_ERROR = `maximize must be one of: ${MAXIMIZE_VALUES.join(", ")} (snake/kebab spellings also accepted)`;
