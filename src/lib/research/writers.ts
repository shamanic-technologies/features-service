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
