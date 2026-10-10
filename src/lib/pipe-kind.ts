/**
 * WHAT KIND OF PIPE a (channel, leg) is, from the channel catalogue alone (owner 2026-10-10: one rule for
 * every pipe, never a channel special case).
 *
 * A pipe is INTERNAL when the channel performs the leg AND the leg starts on a step other than Lead found:
 * its campaigns serve nobody, they act on people another campaign holds, so it is measured on the
 * follow-up ledger (`lib/meeting-leg-fleet.ts` `computeInternalPipeFleet`). A leg read on a channel that
 * does NOT perform the leg (a cold-email channel asked about Positive reply -> Meeting booked) is not a
 * pipe: it keeps the walk of its basis funnel's rates from the signals that channel observes.
 *
 * The catalogue is read at most once a minute per process (seeded rows + declarations).
 */
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { funnelLeg, storedLegKeyOf } from "./funnel-legs.js";
import { isInternalPipe } from "./meeting-leg-fleet.js";

const MEMO_MS = 60_000;
let memo: { at: number; legs: Promise<Map<string, Set<string>>> } | null = null;

function performedLegs(): Promise<Map<string, Set<string>>> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.legs;
  const legs = loadChannelCatalogue({ publishedOnly: false }).then(
    (cat) => new Map(cat.channels.map((c) => [c.slug, new Set(c.stepTransitions.map((t) => storedLegKeyOf(t.legKey)))])),
  );
  memo = { at: Date.now(), legs };
  legs.catch(() => {
    memo = null;
  });
  return legs;
}

/** The pipe's `to` step when (channel, leg) is an INTERNAL pipe the channel performs, else null. */
export async function internalPipeToStep(featureSlug: string, legKey: string): Promise<string | null> {
  const leg = funnelLeg(storedLegKeyOf(legKey));
  if (!leg || !isInternalPipe(leg.fromStep?.key ?? null)) return null;
  const performed = (await performedLegs()).get(featureSlug);
  return performed?.has(leg.legKey) ? leg.toStep.key : null;
}

/** Test seam. */
export function __resetPipeKind(): void {
  memo = null;
}
