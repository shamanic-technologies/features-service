import { leadStateOf } from "./lead-states.js";
import { pipeLegKeyOf } from "./funnel-legs.js";

/**
 * PURE. Each campaign's declared output = the `to` step of its stated (channel, leg) in the catalogue, never inferred
 * from a key's spelling; every step a catalogue pipe ends on. A campaign stating no leg, or a leg the catalogue does not
 * list, has no output (its spend is unattributed).
 */
export function campaignOutputsOf(
  rows: readonly unknown[],
  channels: ReadonlyArray<{ slug: string; stepTransitions: ReadonlyArray<{ legKey: string; to: { key: string } }> }>,
): { outputOf: (campaignId: string) => string | null; pipeOutputs: Set<string> } {
  const toOf = new Map<string, string>();
  const pipeOutputs = new Set<string>();
  for (const c of channels) {
    for (const t of c.stepTransitions) {
      // A pipe produces the lead STATE its step reaches (LEAD-STATES-1024: a reply pipe produces Lead interested).
      const out = leadStateOf(t.to.key) ?? t.to.key;
      toOf.set(`${c.slug}|${pipeLegKeyOf(c.slug, t.legKey)}`, out);
      pipeOutputs.add(out);
    }
  }
  const byCampaign = new Map<string, string>();
  for (const raw of rows) {
    const r = raw as { id?: unknown; featureSlug?: unknown; legKey?: unknown };
    if (typeof r.id !== "string" || typeof r.featureSlug !== "string" || typeof r.legKey !== "string") continue;
    const to = toOf.get(`${r.featureSlug}|${pipeLegKeyOf(r.featureSlug, r.legKey)}`);
    if (to) byCampaign.set(r.id, to);
  }
  return { outputOf: (id) => byCampaign.get(id) ?? null, pipeOutputs };
}
