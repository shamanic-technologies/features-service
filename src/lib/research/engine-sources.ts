/**
 * Where each Research history population sits among the Engines (RESEARCH-NATIVE-ENGINE-1116-P2): read ONCE per build
 * (and once per stored per-population copy re-keyed at read), never per request. Engine of a population = the catalogue's
 * Engine outcome of its (medium x step pair): `outcome`, else its `to` step (the rule campaign-service runs).
 */
import { loadChannelCatalogue } from "../channel-declarations-store.js";
import { pipeLegKeyOf } from "../funnel-legs.js";
import { CHANNEL_STEPS } from "../acquisition-channels.js";
import type { EngineSource } from "./by-engine.js";

/** An outcome's name: its catalogue step's label, else the key spelled out (`email_sent` -> "Email sent"). */
export function stepNameOf(key: string): string {
  const label = (CHANNEL_STEPS as Record<string, { label?: string } | undefined>)[key]?.label;
  return label ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

/** Each history population on its Engine measure; one in no catalogue entry is left out (named in `notCarried`). */
export async function engineSourcesOf(populations: ReadonlyArray<{ id: string; channel: string; leg: string }>): Promise<Array<EngineSource & { channel: string; leg: string }>> {
  const catalogue = await loadChannelCatalogue({ publishedOnly: false });
  return populations.flatMap((p) => {
    const t = catalogue.channels.find((c) => c.slug === p.channel)?.stepTransitions.find((x) => pipeLegKeyOf(p.channel, x.legKey) === pipeLegKeyOf(p.channel, p.leg));
    if (!t) {
      console.error(`[features-service] research by Engine: population ${p.id} is in no catalogue entry, left out (named in notCarried)`);
      return [];
    }
    return [{ sourceId: p.id, engine: t.outcome ?? t.to.key, startsFrom: t.from?.key ?? null, counts: t.to.key, channel: p.channel, leg: p.leg }];
  });
}
