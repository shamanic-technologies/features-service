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
import { INLINE_TRIGGER_IDS } from "./channel-triggers.js";

const MEMO_MS = 60_000;
let memo: { at: number; legs: Promise<Map<string, Set<string>>> } | null = null;
let triggerMemo: { at: number; triggers: Promise<Map<string, string | null>> } | null = null;

/** `<channel>|<stored leg key>` -> the trigger its leg names (null on a proactive leg). */
function legTriggers(): Promise<Map<string, string | null>> {
  if (triggerMemo && Date.now() - triggerMemo.at < MEMO_MS) return triggerMemo.triggers;
  const triggers = loadChannelCatalogue({ publishedOnly: false }).then(
    (cat) => new Map(cat.channels.flatMap((c) => c.stepTransitions.map((t) => [`${c.slug}|${storedLegKeyOf(t.legKey)}`, t.triggerId ?? null] as const))),
  );
  triggerMemo = { at: Date.now(), triggers };
  triggers.catch(() => {
    triggerMemo = null;
  });
  return triggers;
}

/**
 * The trigger when (channel, leg) is an ON-DEMAND pipe (its leg answers an INLINE trigger, `on_demand`: it runs only
 * when another pipe asks for it, as its own unit run), else null. Measured on its own runs and its trigger's ran
 * events (`lib/on-demand-pipe-fleet.ts`), the same rule for every such pipe.
 */
export async function onDemandPipeTrigger(featureSlug: string, legKey: string): Promise<string | null> {
  const trigger = (await legTriggers()).get(`${featureSlug}|${storedLegKeyOf(legKey)}`) ?? null;
  return trigger && INLINE_TRIGGER_IDS.has(trigger) ? trigger : null;
}

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
  triggerMemo = null;
}
