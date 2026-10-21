/**
 * TEMPLATE DYNASTIES ON THE RESEARCH PAGES (TPL-DYNASTY-1021-FS2). Pure.
 *
 * content-generation-service states one template dynasty per pipe (`GET /internal/template-dynasties?featureSlug=&legKey=`,
 * TPL-DYNASTY-1021-CG): a slug, a short name, a one-sentence customer description, an internal signature, blind or
 * named, its ordered versions and its head (the version workflows write with). A Research template bar and page is a
 * DYNASTY: every version's people, outcomes and spend pool into it (the same pooling as a workflow dynasty). A version
 * no dynasty of the pipe lists stays on its own bar, keyed on its own id, `dynasty: null`.
 */
import { templateLabel } from "./format.js";

export interface TemplateDynasty {
  slug: string;
  name: string;
  description: string;
  signature: string | null;
  identity: string;
  head: string | null;
  /** Version template ids, oldest first. */
  versions: string[];
}

/** Why a pipe's template bars carry no dynasty. */
export type TemplateDynastyReason = "template_dynasties_unreadable";

export interface TemplateDynastyIndex {
  /** Template id → the bar it pools into: its dynasty's slug, else the id itself. */
  keyOf: (templateId: string) => string;
  /** Bar key → its label: the dynasty's name, else the version's label. */
  labelOf: (key: string) => string;
  /** Bar key → its dynasty (null = a version on its own). */
  dynastyOf: (key: string) => TemplateDynasty | null;
  /** Template id → the dynasty listing it (null = on its own). */
  dynastyOfVersion: (templateId: string) => TemplateDynasty | null;
  dynasties: readonly TemplateDynasty[];
  /** Set when the dynasties could not be read: every version is its own bar then. */
  unavailableReason: TemplateDynastyReason | null;
}

/** The wave-2 spelling content-generation-service keys a cold email pipe on (`start_to_x` → `lead_found_to_x`). */
export function dynastyLegKeyOf(legKey: string): string {
  return legKey.replace(/^start_to_/, "lead_found_to_");
}

/**
 * PURE. The index of one pipe's dynasties. A version two dynasties of the pipe list (never expected) pools into the
 * first by slug, so the bars stay a partition.
 */
export function templateDynastyIndex(read: readonly TemplateDynasty[] | TemplateDynastyReason): TemplateDynastyIndex {
  const dynasties = typeof read === "string" ? [] : [...read].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const bySlug = new Map(dynasties.map((d) => [d.slug, d]));
  const byVersion = new Map<string, TemplateDynasty>();
  for (const d of dynasties) for (const v of d.versions) if (!byVersion.has(v)) byVersion.set(v, d);
  return {
    keyOf: (id) => byVersion.get(id)?.slug ?? id,
    labelOf: (key) => bySlug.get(key)?.name ?? templateLabel(key),
    dynastyOf: (key) => bySlug.get(key) ?? null,
    dynastyOfVersion: (id) => byVersion.get(id) ?? null,
    dynasties,
    unavailableReason: typeof read === "string" ? read : null,
  };
}

/** No dynasty read (tests, or a pipe whose dynasties were never asked): every version on its own. */
export const NO_TEMPLATE_DYNASTIES: TemplateDynastyIndex = templateDynastyIndex([]);
