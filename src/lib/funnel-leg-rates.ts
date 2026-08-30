/**
 * A BRAND'S CONVERSION RATES ARE READ PER LEG — so a funnel can gain a step without this service
 * knowing about it in advance.
 *
 * Every conversion rate this service prices on used to arrive as a NAMED field: `replyToMeetingPct`,
 * `visitToSignupPct`, one per arrow the four deployed funnels happen to contain. That set is a SCHEMA.
 * A funnel that gains a step — the first is a phone call placed between a positive reply and a booked
 * meeting, and there will be more — has an arrow nobody has a name for, so it cannot be priced until
 * every service in the chain grows a field for it. The schema is the thing in the way, not the data.
 *
 * brand-service now states a rate for an ARBITRARY leg, identified by the two steps it connects, and
 * serves it beside the named rates it still serves (`arrows[]` on each declared funnel, v0.76.0, live).
 * So where this service needs the rate for an arrow, it can ask for THAT arrow's rate.
 *
 * ── PRECEDENCE, STATED ONCE ───────────────────────────────────────────────────────────────────────
 *
 * For any arrow: **a rate stated FOR THAT LEG wins; else the named rate that covers it; else we have no
 * rate for this arrow** — which is a real answer (`null` → the field is dropped, and the brand's
 * effective economics apply unchanged downstream), never a fabricated number, never a default, never an
 * average. The producer already resolves the first two into one figure per leg (`ratePct` +
 * `provenance`), so this module reads that figure rather than re-deriving the precedence — one
 * implementation, and it cannot come to disagree with what brand-service says it decided.
 *
 * ── NO BRAND'S NUMBERS MOVE ───────────────────────────────────────────────────────────────────────
 *
 * A leg-derived rate REPLACES a named one only when some leg on its path is `stated_*` — i.e. only when
 * a human stated a rate for that leg specifically. A brand that has stated only the named rates
 * therefore reads byte-identically to before: the producer's leg carries the named rate's own value with
 * `provenance: "named_rate"`, we take the named path, and nothing changes. A producer that serves no
 * legs at all (a fixture, or an older deploy) is the same case.
 *
 * ── A PATH, NOT A LEG, because that is what makes an INSERTED STEP work ───────────────────────────
 *
 * A named rate names two steps of the funnel; the arrow between them is ONE leg today and becomes
 * SEVERAL the day a step is inserted between them. So a named rate is priced as the product of the
 * rates along the PATH from its first step to its second — `reply→call × call→booked` where a phone
 * call now sits in the middle, and the single leg itself where nothing does. Two rules on that walk,
 * both of which reproduce today's behaviour exactly:
 *
 *  - **The leg that REACHES the destination must be stated**, or the path has no rate. Without it we
 *    know nothing about arriving at the destination, and half a funnel is not a conversion rate. This
 *    is the rule `meetingFunnelCloseRate` has always applied by hand: a show-up rate with no close rate
 *    behind it contributes nothing.
 *  - **An unstated leg EARLIER on the path is silent** (it multiplies in as 100%) rather than voiding
 *    the path. Also today's behaviour: a brand that declared an attended→paid rate and no show-up rate
 *    is priced on the close rate alone, which is exactly the brand-wide semantics.
 *
 * The booked→paid composition (`meetingToClosePct` = show-up × attended→paid) falls out of the same
 * walk instead of being a hand-written special case, which is the point: the next inserted step needs
 * no code here.
 */

import { SALES_FUNNELS, type SalesFunnelKey } from "./sales-funnels.js";

/**
 * One leg of a declared funnel, exactly as brand-service serves it under `arrows[]`. Shape is the
 * PRODUCER's; nothing here is authored by features-service.
 *
 * `provenance` says where the figure came from — `stated_arrow` (a human stated a rate for THIS leg),
 * `named_rate` (it is the named rate that covers this leg), `unstated` (nobody has said, `ratePct` is
 * null). `rateKey` names the named rate when one covers the leg, and is null for a leg no named rate
 * can express — which is precisely the leg an inserted step creates.
 */
export interface DeclaredFunnelLeg {
  fromStep: string;
  toStep: string;
  ratePct: number | null;
  provenance: string;
  rateKey: string | null;
}

/** A leg whose rate a human stated FOR THAT LEG, rather than one derived from a named rate. */
const isStated = (leg: DeclaredFunnelLeg): boolean => leg.provenance.startsWith("stated");

const normaliseStep = (label: string): string => label.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/**
 * Read a declared funnel's legs off the producer's payload.
 *
 * Tolerant of the field being ABSENT (an older brand-service deploy, or a fixture predating this):
 * `[]` then means "this payload carries no leg-level answer", and every caller falls back to the named
 * rates — which is the no-change path, not a gap to fill. Tolerant of the field arriving under either
 * the producer's `arrows` or a later `legs` spelling, because the fleet is renaming that word and a
 * read that survives the rename costs nothing. A malformed entry is skipped rather than throwing: a leg
 * we cannot read is a leg we have no rate for, which the precedence already answers.
 */
export function declaredFunnelLegs(raw: unknown): DeclaredFunnelLeg[] {
  const source = raw as { arrows?: unknown; legs?: unknown } | null | undefined;
  const list = Array.isArray(source?.arrows)
    ? source.arrows
    : Array.isArray(source?.legs)
      ? source.legs
      : [];
  const out: DeclaredFunnelLeg[] = [];
  for (const entry of list as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object") continue;
    const fromStep = typeof entry.fromStep === "string" ? entry.fromStep : null;
    const toStep = typeof entry.toStep === "string" ? entry.toStep : null;
    if (fromStep === null || toStep === null) continue;
    const ratePct =
      typeof entry.ratePct === "number" && Number.isFinite(entry.ratePct) ? entry.ratePct : null;
    out.push({
      fromStep,
      toStep,
      ratePct,
      provenance: typeof entry.provenance === "string" ? entry.provenance : "unstated",
      rateKey: typeof entry.rateKey === "string" ? entry.rateKey : null,
    });
  }
  return out;
}

/** What the walk from one step to another found. */
export interface LegPathRate {
  /** The product of the stated rates along the path, as a percentage. `null` = we have no rate. */
  ratePct: number | null;
  /** Whether a human stated a rate for one of these legs specifically — the only thing that OVERRIDES
   * a named rate, and therefore the guarantee that a brand with no leg-level rates does not move. */
  stated: boolean;
}

const NO_RATE: LegPathRate = { ratePct: null, stated: false };

/**
 * The rate of getting from `fromStep` to `toStep`, read off the funnel's own legs.
 *
 * Walks the chain of legs (linear by construction — a funnel is a chain of steps), so an inserted step
 * is simply one more hop and needs nothing here. See the two rules in this file's header for what an
 * unstated leg does depending on where it sits.
 */
export function legPathRate(
  legs: readonly DeclaredFunnelLeg[],
  fromStep: string,
  toStep: string,
): LegPathRate {
  if (legs.length === 0) return NO_RATE;
  const target = normaliseStep(toStep);
  const byFrom = new Map<string, DeclaredFunnelLeg>();
  for (const leg of legs) {
    const key = normaliseStep(leg.fromStep);
    if (!byFrom.has(key)) byFrom.set(key, leg);
  }

  const walked: DeclaredFunnelLeg[] = [];
  const seen = new Set<string>();
  let cursor = normaliseStep(fromStep);
  while (!seen.has(cursor)) {
    seen.add(cursor);
    const leg = byFrom.get(cursor);
    if (!leg) return NO_RATE;
    walked.push(leg);
    cursor = normaliseStep(leg.toStep);
    if (cursor === target) break;
  }
  if (cursor !== target) return NO_RATE;

  // The leg that REACHES the destination must be stated, or we know nothing about arriving there.
  const last = walked[walked.length - 1]!;
  if (last.ratePct === null) return NO_RATE;

  // Earlier unstated legs are silent — they multiply in as 100% rather than voiding the path.
  let fraction = 1;
  for (const leg of walked) {
    if (leg.ratePct === null) continue;
    fraction *= leg.ratePct / 100;
  }
  return { ratePct: fraction * 100, stated: walked.some(isStated) };
}

/**
 * Which `SalesEconomics` rate prices the arrow between two steps — the ONE place the two vocabularies
 * meet, and it is keyed on the STEPS rather than on a funnel's shape, so it says nothing about how many
 * legs sit between them.
 *
 * Every entry but one is a pair of steps that are ADJACENT in the deployed catalogue. The exception is
 * `Meeting booked → Paid client`, which spans the show-up leg on purpose: our `meetingToClosePct` is
 * BOOKED → paid while brand-service's identically-named rate is ATTENDED → paid, so the composition is
 * the whole difference between the two services' meaning of that field (see `meetingFunnelCloseRate`).
 */
const RATE_FOR_STEP_PAIR: ReadonlyArray<{ from: string; to: string; key: string }> = [
  { from: "Positive reply", to: "Meeting booked", key: "replyToMeetingPct" },
  { from: "Website visit", to: "Meeting booked", key: "visitToMeetingPct" },
  { from: "Meeting attended", to: "Paid client", key: "meetingAttendedToPaidClientPct" },
  { from: "Meeting booked", to: "Paid client", key: "meetingToClosePct" },
  { from: "Website visit", to: "Signup", key: "visitToSignupPct" },
  { from: "Signup", to: "Paid client", key: "signupToPaidClientPct" },
  { from: "Website visit", to: "Form filled", key: "visitToFormSubmissionPct" },
  { from: "Form filled", to: "Paid client", key: "formSubmissionToPaidClientPct" },
];

/**
 * Every `SalesEconomics` rate this funnel's own legs can answer for, taken from the legs.
 *
 * Only the pairs whose two steps are both steps of THIS funnel, in this order, are asked for — a
 * question about a step the funnel does not have has no answer here, and a multi-hop pair that is not
 * one of this funnel's own arrows (a website visit reaching a paid client THROUGH a meeting) is a
 * different quantity from the direct self-serve rate that shares its name, so it is never derived.
 *
 * A rate is returned ONLY when some leg on its path was stated for that leg specifically. Everything
 * else keeps the named answer it has today.
 */
export function statedLegRates(
  funnelKey: SalesFunnelKey,
  legs: readonly DeclaredFunnelLeg[],
): Record<string, number> {
  const out: Record<string, number> = {};
  if (legs.length === 0) return out;
  const steps = SALES_FUNNELS[funnelKey].steps.map(normaliseStep);
  for (const pair of RATE_FOR_STEP_PAIR) {
    const fromIndex = steps.indexOf(normaliseStep(pair.from));
    const toIndex = steps.indexOf(normaliseStep(pair.to));
    if (fromIndex === -1 || toIndex === -1 || toIndex <= fromIndex) continue;
    const path = legPathRate(legs, pair.from, pair.to);
    if (!path.stated || path.ratePct === null) continue;
    out[pair.key] = path.ratePct;
  }
  return out;
}
