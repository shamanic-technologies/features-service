/**
 * WHAT A PIPE'S ENGINE WRITES WITH TODAY (LLM-RATING-PER-ENGINE-1112): the Rating's favourite LLM and favourite template
 * dynasty for the Engine a catalogue pipe produces (its finer outcome, else its `to` step). Read by the Research
 * Performance tab's "served now" (it read the deleted per-pipe writer pick). Same figures as the staff read
 * `/internal/research/engine-llms`; held 60 s per Engine.
 */
import { engineLlmBody, type EngineLlmBody } from "./engine-llm-rating.js";
import { readRatingInputs } from "./engine-llm-rating-io.js";
import { engineTemplateLines, listTemplatePicks } from "./engine-template-rating-io.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { pipeLegKeyOf } from "./funnel-legs.js";

export interface EngineFavourites {
  outcome: string;
  llm: { key: string; name: string } | null;
  template: { key: string; name: string } | null;
}

const HOLD_MS = 60_000;
const held = new Map<string, { at: number; value: Promise<EngineFavourites> }>();

/** The Engine outcome of one catalogue pipe; null = the catalogue lists no such pipe. */
export async function pipeEngineOutcome(featureSlug: string, legKey: string): Promise<string | null> {
  const catalogue = await loadChannelCatalogue({ publishedOnly: false });
  const t = catalogue.channels.find((c) => c.slug === featureSlug)?.stepTransitions.find((x) => pipeLegKeyOf(featureSlug, x.legKey) === pipeLegKeyOf(featureSlug, legKey));
  return t ? (t.outcome ?? t.to.key) : null;
}

/** PURE: the favourite of a body (null when nothing can be picked). */
const favouriteOf = (b: EngineLlmBody) => (b.favourite ? { key: b.favourite.llmDynastySlug, name: b.favourite.name } : null);

/** The Engine's favourite LLM and template today. FAIL-LOUD. */
export function engineFavourites(outcome: string): Promise<EngineFavourites> {
  const hit = held.get(outcome);
  if (hit && Date.now() - hit.at < HOLD_MS) return hit.value;
  const value = (async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [inputs, lines, templatePicks] = await Promise.all([readRatingInputs(`engine favourites ${outcome}`), engineTemplateLines(outcome), listTemplatePicks("2026-11-01")]);
    const llmBody = engineLlmBody({ outcome, rules: inputs.rules, lines: inputs.lines, evidence: (inputs.build?.evidence ?? []).filter((e) => e.outcome === outcome), picks: inputs.picks, outOfCreditProviders: inputs.outOfCreditProviders, today });
    const tplBody = engineLlmBody({
      outcome,
      rules: [],
      lines: lines.map((l) => ({ slug: l.slug, name: l.name, provider: "", servedToday: l.pickable })),
      evidence: (inputs.build?.templates ?? []).filter((e) => e.outcome === outcome),
      picks: templatePicks,
      outOfCreditProviders: new Set(),
      today,
    });
    return { outcome, llm: favouriteOf(llmBody), template: favouriteOf(tplBody) };
  })();
  held.set(outcome, { at: Date.now(), value });
  value.catch(() => {
    if (held.get(outcome)?.value === value) held.delete(outcome);
  });
  return value;
}
