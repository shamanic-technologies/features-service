/**
 * The LLM dynasties the Engine a PIPE produces may use (LLM-RATING-PER-ENGINE-1112): the legacy per-pipe writer ranking
 * reads it so it never answers an LLM the Engine's universe leaves out (Claude Fable, Claude Opus). The pipe's Engine =
 * its finer outcome, else its `to` step. FAIL-LOUD (a failed read is never "every LLM"). Deleted with the legacy ranking.
 */
import { listUniverseRules } from "./engine-llm-store.js";
import { FLEET_UNIVERSE, universeOf } from "./engine-llm-rating.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { readLlmDynasties } from "./llm-dynasties.js";
import { pipeLegKeyOf } from "./funnel-legs.js";

export async function pipeLlmUniverse(featureSlug: string, legKey: string): Promise<ReadonlySet<string>> {
  const [rules, dynasties, catalogue] = await Promise.all([listUniverseRules(), readLlmDynasties(), loadChannelCatalogue({ publishedOnly: false })]);
  const t = catalogue.channels.find((c) => c.slug === featureSlug)?.stepTransitions.find((x) => pipeLegKeyOf(featureSlug, x.legKey) === pipeLegKeyOf(featureSlug, legKey));
  const outcome = t ? (t.outcome ?? t.to.key) : FLEET_UNIVERSE;
  return new Set(universeOf(outcome, rules, dynasties.map((d) => ({ slug: d.slug, name: d.name, provider: d.provider, servedToday: d.servedToday }))).allowed);
}
