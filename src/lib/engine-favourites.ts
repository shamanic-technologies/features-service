/**
 * WHAT AN ENGINE WRITES WITH TODAY (SCRIPT-VALUE-RATING-1113-MON, owner 2026-11-13: « un pick = toujours un script », the
 * LLM and the template are tactics of the script). The Rating's favourite SCRIPT of an Engine, read off Monitoring's stored
 * board (`routes/script-engines.ts`), and the LLM and template that script states (its writer's when it names places, else
 * its first). Read by the Research Performance tab by Engine's `servedNow` (`routes/research-engines.ts`). The LLM is named
 * by its chat-service dynasty (the Research model pages' key).
 */
import type { BoardEngine, ScriptLlmTactic, ScriptTemplateTactic } from "./script-engine-board.js";

/** The fleet cell Monitoring's board is stored under (`routes/script-engines.ts` writes it). */
export const SCRIPT_ENGINES_CELL = "script-engines-v1";

export interface EngineFavourites {
  outcome: string;
  script: string | null;
  llm: { key: string; name: string } | null;
  template: { key: string; name: string } | null;
}

/** PURE: the writer's entry when places are named, else the first. */
export function writingTactic<T extends { place: string | null }>(list: readonly T[]): T | null {
  return list.find((t) => t.place === null) ?? list.find((t) => t.place === "writer") ?? list[0] ?? null;
}

/** PURE: the favourite script of one Engine's board and the LLM / template it states. */
export function favouritesOfBoard(
  engine: Pick<BoardEngine, "outcome" | "favourite" | "scripts">,
  dynastyOfName: (name: string) => { slug: string; name: string } | null,
): EngineFavourites {
  const row = engine.favourite ? engine.scripts.find((s) => s.scriptDynasty === engine.favourite) ?? null : null;
  const llm: ScriptLlmTactic | null = row ? writingTactic(row.llms) : null;
  const tpl: ScriptTemplateTactic | null = row ? writingTactic(row.templates) : null;
  const dyn = llm?.model ? dynastyOfName(llm.model) : null;
  return {
    outcome: engine.outcome,
    script: engine.favourite,
    llm: llm?.model ? (dyn ? { key: dyn.slug, name: dyn.name } : { key: llm.model, name: llm.model }) : null,
    template: tpl ? { key: tpl.templateDynastySlug, name: tpl.templateDynastySlug } : null,
  };
}
