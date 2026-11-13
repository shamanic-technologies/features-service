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

/**
 * The Research Performance tab (RESEARCH-PERFORMANCE-1023) with each row's workflow mark (on `workflow`) and its template
 * page's mark (on `template` and its `dynasty` ref); LLM rows carry none (the dashboard's logos).
 */
export async function withPerformanceMarks<
  R extends { workflow: { key: string }; template: { key: string; dynasty: { key: string } | null } | null },
  T extends Record<string, { rows: R[] }>,
>(pipes: T): Promise<T> {
  const all = Object.values(pipes).flatMap((p) => p.rows);
  const [wf, tpl] = await Promise.all([
    marksFor("workflow", all.map((r) => r.workflow.key)),
    marksFor("template", all.flatMap((r) => (r.template ? [r.template.key] : []))),
  ]);
  return Object.fromEntries(
    Object.entries(pipes).map(([id, p]) => [
      id,
      {
        ...p,
        rows: p.rows.map((r) => ({
          ...r,
          workflow: withMark(r.workflow, wf.get(r.workflow.key)),
          // the template page's mark (its key: the dynasty slug, or a standalone version's id), also on its dynasty ref
          template: r.template
            ? { ...withMark(r.template, tpl.get(r.template.key)), dynasty: r.template.dynasty ? withMark(r.template.dynasty, tpl.get(r.template.dynasty.key)) : null }
            : null,
        })),
      },
    ]),
  ) as T;
}

/**
 * SCRIPT-MARKS-1103 (owner 2026-11-03, « Tu utilises les icônes Workflow pour les objets scripts, c'est normal ? »): every
 * workflow (script) an Engine read names carries its dynasty's served mark, the same `icon` + `color` Research shows for it.
 * Both null when the dynasty has no mark (never a substitute look); the consumer draws a neutral mark.
 */
export interface ScriptMark {
  icon: string | null;
  color: string | null;
}
type WorkflowRef = { workflowDynastySlug: string };

/** PURE: `ref` + its mark, `icon`/`color` null when none. */
export function withScriptMark<T extends WorkflowRef>(ref: T, mark: CatalogueMark | undefined): T & ScriptMark {
  return { ...ref, icon: mark ? mark.icon : null, color: mark ? mark.color : null };
}

/** The customer engine picks (`GET /offers/:offerId/engine-picks`), each pick with its workflow's mark. */
export async function withEnginePickMarks<T extends WorkflowRef>(picks: readonly T[]): Promise<Array<T & ScriptMark>> {
  const marks = await marksFor("workflow", picks.map((p) => p.workflowDynastySlug));
  return picks.map((p) => withScriptMark(p, marks.get(p.workflowDynastySlug)));
}

type StoredPlaceRefs = { today?: WorkflowRef | null; engine?: WorkflowRef | null; engineModal?: WorkflowRef | null; candidates?: WorkflowRef[] };

/**
 * A stored per-campaign factory body (`GET /brands/:brandId/sales-funnel-campaigns/:id/factory-shadow`) with every Engine
 * place's workflow refs marked: `today`, `engine`, `engineModal` and each of `candidates[]`. Any other field is untouched;
 * a body with no Engine places is returned as stored.
 */
export async function withFactoryEngineMarks<B>(body: B): Promise<B> {
  const engine = (body as { engine?: { places?: StoredPlaceRefs[] } } | null)?.engine;
  if (!engine || !Array.isArray(engine.places)) return body;
  const refsOf = (p: StoredPlaceRefs) => [...[p.today, p.engine, p.engineModal].filter((r): r is WorkflowRef => !!r), ...(p.candidates ?? [])];
  const marks = await marksFor("workflow", engine.places.flatMap((p) => refsOf(p).map((r) => r.workflowDynastySlug)));
  const mark = <R extends WorkflowRef>(r: R | null | undefined) => (r ? withScriptMark(r, marks.get(r.workflowDynastySlug)) : r);
  return {
    ...body,
    engine: {
      ...engine,
      places: engine.places.map((p) => ({
        ...p,
        ...("today" in p ? { today: mark(p.today) } : {}),
        ...("engine" in p ? { engine: mark(p.engine) } : {}),
        ...("engineModal" in p ? { engineModal: mark(p.engineModal) } : {}),
        ...(p.candidates ? { candidates: p.candidates.map((c) => mark(c)!) } : {}),
      })),
    },
  } as B;
}

/** A campaign's people journeys (`GET /brands/:brandId/sales-funnel-campaigns/:id/people-journeys`), each script with its mark. */
export async function withJourneyScriptMarks<S extends WorkflowRef, T extends { scripts: S[] }>(transitions: readonly T[]): Promise<Array<T & { scripts: Array<S & ScriptMark> }>> {
  const marks = await marksFor("workflow", transitions.flatMap((t) => t.scripts.map((s) => s.workflowDynastySlug)));
  return transitions.map((t) => ({ ...t, scripts: t.scripts.map((s) => withScriptMark(s, marks.get(s.workflowDynastySlug))) }));
}
