/**
 * WHAT A WORKFLOW WRITES WITH NOW (RESEARCH-PAGES-ALL-1018, owner 2026-10-18: « Every workflow still valid for this pipe
 * must have its own page, and those pages must be created automatically »). Pure: the template and model of a dynasty's
 * RUNNABLE version, read off its DAG (the content-generation `/generate` step's body `type` + `model`), the model alias
 * resolved to the real model by chat-service's own alias list. Never what most of its people were written with (that is
 * the generation feed's `wroteWithMost`): a new version writes with a new template before it sent anything.
 */
import type { WorkflowDefinition } from "../workflow-definitions-client.js";

export interface ModelIdRow {
  modelId: string;
  displayName: string;
  aliases: readonly string[];
  formerAliases: readonly string[];
}

export type WriterReason = "workflow_definitions_unreadable" | "no_runnable_version" | "no_writing_step";

export type DynastyWriter =
  | { ok: true; workflowSlug: string; version: number; template: string | null; modelAlias: string | null; model: { id: string; label: string } | null }
  | { ok: false; reason: WriterReason };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** PURE. The template and model alias the DAG's content-generation step writes with; null when no step writes. */
export function writerOfDag(dag: unknown): { template: string; modelAlias: string | null } | null {
  const nodes = isRecord(dag) && Array.isArray(dag.nodes) ? dag.nodes : [];
  for (const node of nodes) {
    const config = isRecord(node) && isRecord(node.config) ? node.config : null;
    if (!config || config.service !== "content-generation") continue;
    const body = isRecord(config.body) ? config.body : null;
    if (!body || typeof body.type !== "string" || !body.type) continue;
    return { template: body.type, modelAlias: typeof body.model === "string" && body.model ? body.model : null };
  }
  return null;
}

/** PURE. A model alias (or a concrete id) → the real model chat-service serves for it; null when it names none. */
export function resolveModelAlias(alias: string, models: readonly ModelIdRow[]): { id: string; label: string } | null {
  const hit =
    models.find((m) => m.modelId === alias) ?? models.find((m) => m.aliases.includes(alias)) ?? models.find((m) => m.formerAliases.includes(alias));
  return hit ? { id: hit.modelId, label: hit.displayName } : null;
}

export type ModelAliasReason = "model_ids_unreadable" | "model_not_in_chat_service" | "no_alias_serves_it";

/**
 * PURE. The aliases a Research model row is served under (TEMPLATE-MODEL-STATUS-1019): every concrete model chat-service
 * lists whose page key is the row's (`pageKeyOf`: its LLM dynasty's slug since LLM-DYNASTY-1022-FS, else `modelKey` of its
 * display name), and
 * every CURRENT alias chat-service resolves to one of them. Read off chat-service's own alias list, never off which
 * workflows ran. Several aliases = chat-service truly serves the model under each (`deepseek-flash` and `deepseek-pro`
 * both resolve to DeepSeek V4.1 Flash on 2026-10-19). An alias that once named it but now names another model is a
 * former alias: a status set on it acts on the other model.
 */
export function modelRowAliases(
  rowKey: string,
  models: readonly ModelIdRow[] | ModelAliasReason,
  pageKeyOf: (m: ModelIdRow) => string,
): { modelIds: string[]; aliases: string[]; formerAliases: string[]; aliasesUnavailableReason: ModelAliasReason | null } {
  if (typeof models === "string") return { modelIds: [], aliases: [], formerAliases: [], aliasesUnavailableReason: models };
  const hits = models.filter((m) => pageKeyOf(m) === rowKey);
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
  const aliases = sorted(hits.flatMap((m) => m.aliases));
  const formerAliases = sorted(hits.flatMap((m) => m.formerAliases)).filter((a) => !aliases.includes(a));
  const aliasesUnavailableReason: ModelAliasReason | null = hits.length === 0 ? "model_not_in_chat_service" : aliases.length === 0 ? "no_alias_serves_it" : null;
  return { modelIds: sorted(hits.map((m) => m.modelId)), aliases, formerAliases, aliasesUnavailableReason };
}

/**
 * PURE. Per dynasty, what its NEWEST version that writes (any status, deprecated included) writes with
 * (RESEARCH-DEPRECATED-LLM-TEMPLATE-1019): the stand-in for "what wrote its figures" when no generated sequence of it
 * was recorded. Never what it writes with now (a deprecated dynasty writes nothing now).
 */
export function dynastyLastWriters(definitions: readonly WorkflowDefinition[], models: readonly ModelIdRow[]): Map<string, DynastyWriter> {
  const byDynasty = new Map<string, WorkflowDefinition[]>();
  for (const d of definitions) byDynasty.set(d.workflowDynastySlug, [...(byDynasty.get(d.workflowDynastySlug) ?? []), d]);
  const out = new Map<string, DynastyWriter>();
  for (const [dynasty, defs] of byDynasty) {
    const writing = defs
      .map((d) => ({ d, w: writerOfDag(d.dag) }))
      .filter((x): x is { d: WorkflowDefinition; w: { template: string; modelAlias: string | null } } => x.w !== null)
      .sort((a, b) => b.d.version - a.d.version)[0];
    if (!writing) {
      out.set(dynasty, { ok: false, reason: "no_writing_step" });
      continue;
    }
    out.set(dynasty, {
      ok: true,
      workflowSlug: writing.d.workflowSlug,
      version: writing.d.version,
      template: writing.w.template,
      modelAlias: writing.w.modelAlias,
      model: writing.w.modelAlias ? resolveModelAlias(writing.w.modelAlias, models) : null,
    });
  }
  return out;
}

/** PURE. Per dynasty, what its runnable version (the highest active version) writes with. */
export function dynastyWriters(definitions: readonly WorkflowDefinition[], models: readonly ModelIdRow[]): Map<string, DynastyWriter> {
  const byDynasty = new Map<string, WorkflowDefinition[]>();
  for (const d of definitions) byDynasty.set(d.workflowDynastySlug, [...(byDynasty.get(d.workflowDynastySlug) ?? []), d]);
  const out = new Map<string, DynastyWriter>();
  for (const [dynasty, defs] of byDynasty) {
    const runnable = defs.filter((d) => d.versionActive).sort((a, b) => b.version - a.version)[0];
    if (!runnable) {
      out.set(dynasty, { ok: false, reason: "no_runnable_version" });
      continue;
    }
    const w = writerOfDag(runnable.dag);
    if (!w) {
      out.set(dynasty, { ok: false, reason: "no_writing_step" });
      continue;
    }
    out.set(dynasty, {
      ok: true,
      workflowSlug: runnable.workflowSlug,
      version: runnable.version,
      template: w.template,
      modelAlias: w.modelAlias,
      model: w.modelAlias ? resolveModelAlias(w.modelAlias, models) : null,
    });
  }
  return out;
}

/**
 * PURE (RESEARCH-PERFORMANCE-1023). Per workflow VERSION, what its own definition writes with (its DAG's
 * content-generation step), else its dynasty's newest writing version (`dynastyLastWriters`, the catalogue's
 * `wroteWith` fallback): the writer of a person no generated sequence records. `model` = the concrete id the alias
 * resolves to, else the alias itself (the LLM dynasty index places both).
 */
export function versionWriters(
  definitions: readonly WorkflowDefinition[],
  models: readonly ModelIdRow[],
  last: ReadonlyMap<string, DynastyWriter>,
): Map<string, { template: string | null; model: string | null }> {
  const out = new Map<string, { template: string | null; model: string | null }>();
  for (const d of definitions) {
    const own = writerOfDag(d.dag);
    if (own) {
      out.set(d.workflowSlug, { template: own.template, model: own.modelAlias ? (resolveModelAlias(own.modelAlias, models)?.id ?? own.modelAlias) : null });
      continue;
    }
    const w = last.get(d.workflowDynastySlug);
    if (w?.ok) out.set(d.workflowSlug, { template: w.template, model: w.model?.id ?? w.modelAlias });
  }
  return out;
}
