import type { ChannelStepTransitionWire, PublicChannel } from "./channel-catalogue.js";
import { pipeIdentityOf } from "./agent-catalogue.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { campaignNameKeyOf } from "./offer-sales-paths.js";
import { salesPathNamesFor } from "./sales-path-names.js";

/**
 * Every leg of the published channels with its PIPE identity (owner 2026-10-18, PIPE-PUBLIC-MARK-1018): the
 * name the staff catalogue gives the pipe (same key, `campaignNameKeyOf(slug, served leg key)`, same table,
 * named on first sight like the staff list), its id, glyph and colour through `pipeIdentityOf`. A customer
 * page draws the bird the staff page draws. Run AFTER `withCampaignNames` so already-named pipes keep their
 * order of first sight. Fail-loud like `salesPathNamesFor`.
 */
export async function withPipeIdentities(channels: readonly PublicChannel[]): Promise<PublicChannel[]> {
  const keyOf = (slug: string, legKey: string) => campaignNameKeyOf(slug, servedLegKeyOf(slug, legKey));
  const names = await salesPathNamesFor(channels.flatMap((c) => c.stepTransitions.map((t) => keyOf(c.slug, t.legKey))));
  return channels.map((c) => ({
    ...c,
    stepTransitions: c.stepTransitions.map((t): ChannelStepTransitionWire => {
      const name = names.get(keyOf(c.slug, t.legKey));
      if (!name) throw new Error(`pipe ${c.slug} × ${t.legKey} has no name`);
      return { ...t, pipe: pipeIdentityOf(c.slug, servedLegKeyOf(c.slug, t.legKey), name) };
    }),
  }));
}
