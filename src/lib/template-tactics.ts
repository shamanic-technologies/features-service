/**
 * Serving each TEMPLATE dynasty's tactics (TPL-TACTICS-ROWS-1022): the template twin of the workflow ranking rows'
 * `tactics` (`workflowTacticsFrom`, routes/public.ts). Template tactics (the email angles: Blind / Named / Offer angle)
 * are judged on each dynasty's HEAD text (`sweepWriterTacticJudgments`, verdicts in `writer_tactic_verdicts`, keyed on
 * the dynasty slug). Read live at every request, never from a stored build, so the Templates list and writer-pick read
 * the same verdicts.
 */
import { loadPlayCatalogue } from "./plays-store.js";
import { subjectOfTactic, writerSubjectKey, type PlayCatalogue } from "./plays.js";

export type TemplateTactics = Array<{ id: string; name: string }>;
export type TemplateTacticsReason = "tactics_unreadable" | "not_judged_yet";
export type TemplateTacticsOf = (templateKey: string) => TemplateTactics | "not_judged_yet";

/**
 * PURE. The template tactics a template dynasty follows (judged yes), name order; `not_judged_yet` when it lacks a
 * verdict on any template tactic (unknown is never an empty list: the page would read "None"). `[]` = judged, follows none.
 */
export function templateTacticsFrom(c: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">): TemplateTacticsOf {
  const templateTactics = [...c.tactics.values()].filter((t) => subjectOfTactic(t) === "template");
  return (key) => {
    const verdicts = c.tacticsByWriter.get(writerSubjectKey("template", key));
    if (templateTactics.length > 0 && (!verdicts || templateTactics.some((t) => !verdicts.has(t.id)))) return "not_judged_yet";
    return templateTactics
      .filter((t) => verdicts?.get(t.id) === true)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  };
}

/** PURE. Each row with `tactics` + `tacticsUnavailableReason` (null `tacticsOf` = the catalogue could not be read). */
export function withTemplateTactics<T extends { key: string }>(rows: readonly T[], tacticsOf: TemplateTacticsOf | null): Array<T & { tactics: TemplateTactics | null; tacticsUnavailableReason: TemplateTacticsReason | null }> {
  return rows.map((r) => {
    if (!tacticsOf) return { ...r, tactics: null, tacticsUnavailableReason: "tactics_unreadable" as const };
    const t = tacticsOf(r.key);
    return t === "not_judged_yet" ? { ...r, tactics: null, tacticsUnavailableReason: t } : { ...r, tactics: t, tacticsUnavailableReason: null };
  });
}

/** The live template tactics; null (logged loud) when the play catalogue cannot be read: rows then say `tactics_unreadable`. */
export async function readTemplateTactics(): Promise<TemplateTacticsOf | null> {
  try {
    return templateTacticsFrom(await loadPlayCatalogue());
  } catch (error) {
    console.error("[features-service] template tactics unreadable, template rows serve none:", error);
    return null;
  }
}
