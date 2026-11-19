/**
 * The catalogue's label of an outcome (coded steps, lead states, declared steps), as a client reads it; an outcome the
 * catalogue does not list reads as its key in words. One reader for every surface naming an outcome.
 */
import { CHANNEL_STEPS } from "./acquisition-channels.js";
import { NEW_LEAD_STATE_STEPS } from "./lead-states.js";
import { listDeclaredSteps } from "./channel-declarations-store.js";

const titleOf = (key: string) => key.split("_").map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");

export async function listOutcomeLabels(): Promise<(outcomeKey: string) => string> {
  const declared = await listDeclaredSteps();
  const labels = new Map<string, string>([
    ...Object.entries(CHANNEL_STEPS).map(([k, v]) => [k, v.label] as const),
    ...NEW_LEAD_STATE_STEPS.map((s) => [s.key, s.label] as const),
    ...declared.map((d) => [d.key, d.label] as const),
  ]);
  return (key) => labels.get(key) ?? titleOf(key);
}
