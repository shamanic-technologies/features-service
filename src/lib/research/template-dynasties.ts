/**
 * TEMPLATE DYNASTIES ON THE RESEARCH PAGES (TPL-DYNASTY-1021-FS2). Pure.
 *
 * content-generation-service states one template dynasty per pipe (`GET /internal/template-dynasties?featureSlug=&legKey=`,
 * TPL-DYNASTY-1021-CG): a slug, a short name, a one-sentence customer description, an internal signature, blind or
 * named, its ordered versions and its head (the version workflows write with). A Research template bar and page is a
 * DYNASTY: every version's people, outcomes and spend pool into it (the same pooling as a workflow dynasty). A version
 * no dynasty of the pipe lists stays on its own bar, keyed on its own id, `dynasty: null`.
 *
 * One template, one dynasty (TPL-DYNASTY-ONE-HOME-1021-FS, owner 2026-10-21): content-generation-service split every
 * template two dynasties shared, the original stays in one, the other holds a COPY at the same position and states it
 * on the version (`copiedFrom`). The emails the copy's pipe wrote before the split carry the ORIGINAL's name, so on a
 * pipe a template a dynasty of that pipe lists as a version's `copiedFrom` counts for that dynasty and that version.
 * A template the pipe's dynasties list directly always wins over a copy's origin.
 */
import { templateLabel } from "./format.js";
import { servedLegKeyOf } from "../funnel-legs.js";

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
  /** Version template id → the original template it is a copy of (content-generation `copiedFrom`); absent = none. */
  copiedFrom?: Readonly<Record<string, string>>;
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
  /** Template id → the dynasty listing it, or listing a copy of it (null = on its own). */
  dynastyOfVersion: (templateId: string) => TemplateDynasty | null;
  /** Template id → the version it counts for: itself, else the copy of it a dynasty of the pipe lists. */
  versionOf: (templateId: string) => string;
  dynasties: readonly TemplateDynasty[];
  /** Set when the dynasties could not be read: every version is its own bar then. */
  unavailableReason: TemplateDynastyReason | null;
}

/**
 * The leg spelling content-generation-service keys a pipe's dynasties on: the channel's SERVED spelling (an outbound
 * channel's two legacy keys `start_to_conversation` / `start_to_website_visit` → `lead_found_to_*`, every other leg
 * verbatim). Was a blanket `start_to_` → `lead_found_to_`, which asked Cold WhatsApp's `start_to_signup` as
 * `lead_found_to_signup` and found no template (WA-PIPE-RESEARCH-1023).
 */
export function dynastyLegKeyOf(featureSlug: string, legKey: string): string {
  return servedLegKeyOf(featureSlug, legKey);
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
  // An original a version of the pipe was copied from counts for that copy (unless the pipe lists the original itself).
  const copyOf = new Map<string, string>();
  for (const d of dynasties)
    for (const v of d.versions) {
      const from = d.copiedFrom?.[v];
      if (from && !byVersion.has(from) && !copyOf.has(from)) copyOf.set(from, v);
    }
  const versionOf = (id: string) => copyOf.get(id) ?? id;
  return {
    keyOf: (id) => byVersion.get(versionOf(id))?.slug ?? id,
    labelOf: (key) => bySlug.get(key)?.name ?? templateLabel(key),
    dynastyOf: (key) => bySlug.get(key) ?? null,
    dynastyOfVersion: (id) => byVersion.get(versionOf(id)) ?? null,
    versionOf,
    dynasties,
    unavailableReason: typeof read === "string" ? read : null,
  };
}

/** No dynasty read (tests, or a pipe whose dynasties were never asked): every version on its own. */
export const NO_TEMPLATE_DYNASTIES: TemplateDynastyIndex = templateDynastyIndex([]);
