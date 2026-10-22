/**
 * Serving the workflow / template marks (MARKS-1022, rule in `lib/catalogue-marks.ts`): every read that names a workflow
 * dynasty or a template dynasty passes its rows through here, so the same dynasty serves the same `icon` + `color` on
 * every surface (leg workflow ranking, leg writer ranking, Research catalogue, agent catalogue). Marks are given on
 * first sight in the order the read lists the rows (the best-ranked new object takes the earlier mark).
 */
import { marksFor } from "./catalogue-marks-store.js";
import type { CatalogueMark, MarkFamily } from "./catalogue-marks.js";

type Marked<T> = T & { icon?: string; color?: string };

/** PURE: `row` + its mark (fields `icon`, `color`), untouched when it has none. */
export function withMark<T extends object>(row: T, mark: CatalogueMark | undefined): Marked<T> {
  return mark ? { ...row, icon: mark.icon, color: mark.color } : row;
}

/** Each row with the mark of `keyOf(row)` in `family`. Fail-loud (a store failure throws). */
export async function withMarks<T extends object>(family: MarkFamily, rows: readonly T[], keyOf: (row: T) => string): Promise<Array<Marked<T>>> {
  const marks = await marksFor(family, rows.map(keyOf));
  return rows.map((r) => withMark(r, marks.get(keyOf(r))));
}

/** A leg workflow ranking body with every row's workflow mark. */
export async function withWorkflowRankingMarks<T extends { rows: ReadonlyArray<{ workflowDynastySlug: string }> }>(payload: T): Promise<T> {
  return { ...payload, rows: await withMarks("workflow", payload.rows, (r) => r.workflowDynastySlug) };
}

/** A served writer ranking with every TEMPLATE row's mark (`best` is the same row, marked); LLM rows carry none. */
export async function withTemplateRankingMarks<R extends { key: string }, T extends { templates: { rows: R[]; best: R | null } }>(served: T): Promise<T> {
  const rows = await withMarks("template", served.templates.rows, (r) => r.key);
  const best = served.templates.best ? (rows.find((r) => r.key === served.templates.best!.key) ?? null) : null;
  return { ...served, templates: { ...served.templates, rows, best } };
}

/** The Research catalogue with every workflow page's and template page's mark (keyed on the page `key` = the dynasty slug). */
export async function withResearchCatalogMarks<W extends { key: string }, P extends { key: string }, T extends Record<string, { workflows: W[]; templates: P[] }>>(catalog: T): Promise<T> {
  const pipes = Object.values(catalog);
  const [wf, tpl] = await Promise.all([marksFor("workflow", pipes.flatMap((p) => p.workflows.map((w) => w.key))), marksFor("template", pipes.flatMap((p) => p.templates.map((t) => t.key)))]);
  return Object.fromEntries(
    Object.entries(catalog).map(([id, p]) => [id, { ...p, workflows: p.workflows.map((w) => withMark(w, wf.get(w.key))), templates: p.templates.map((t) => withMark(t, tpl.get(t.key))) }]),
  ) as T;
}
