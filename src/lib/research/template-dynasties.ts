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
  /**
   * The dynasty's status (TPL-DYNASTY-ROWS-1021-FS). content-generation-service's own when it serves one
   * (`statusSource: content_generation`); until then the owner rule (2026-10-21) on the version statuses it serves:
   * deprecated exactly when every version is (`all_versions_deprecated`). Null when neither is stated.
   */
  status: TemplateStatus | null;
  statusSource: TemplateDynastyStatusSource | null;
  /** Version template id → content-generation-service's status of that version (null = not stated). */
  versionStatuses: Readonly<Record<string, TemplateStatus | null>>;
}

export type TemplateStatus = "active" | "deprecated";
export type TemplateDynastyStatusSource = "content_generation" | "all_versions_deprecated";

/**
 * PURE. A dynasty's status: content-generation-service's when served, else deprecated exactly when every version is
 * (owner 2026-10-21: only the head is Active; a dynasty is Deprecated exactly when all its versions are).
 */
export function dynastyStatusOf(
  served: unknown,
  versions: ReadonlyArray<{ status: TemplateStatus | null }>,
): { status: TemplateStatus | null; statusSource: TemplateDynastyStatusSource | null } {
  if (served === "active" || served === "deprecated") return { status: served, statusSource: "content_generation" };
  if (!versions.length || versions.some((v) => v.status === null)) return { status: null, statusSource: null };
  return { status: versions.every((v) => v.status === "deprecated") ? "deprecated" : "active", statusSource: "all_versions_deprecated" };
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
