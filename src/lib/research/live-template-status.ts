/**
 * A TEMPLATE'S STATUS IS READ LIVE (TPL-STATUS-LIVE-1023, owner 2026-10-23: « I deprecated a template but it still shows
 * as active on this page »). The Research catalogue is a stored build (rebuilt every ~15 min, longer when a build fails),
 * so a template deprecated (or upgraded) on content-generation-service kept its build-time status, head and version
 * statuses until the next build. Every catalogue read now lays content-generation's CURRENT dynasties over each template
 * row, the way it already lays the current ranking figures and template tactics: the dynasty status (+ its source), the
 * head, each version's head flag and status. A version the build has not seen yet (an upgrade minted it) is listed with
 * zero figures until the next build measures it. Figures, ranks and returns stay the build's.
 *
 * Pure. A pipe whose dynasties could not be read keeps the build's rows (the read logs loud); a dynasty content-generation
 * no longer lists keeps its build row too (nothing to say about it).
 */
import { n, templateLabel, usd } from "./format.js";
import type { CatalogTemplate, CatalogTemplateVersion } from "./catalog.js";
import type { TemplateDynasty, TemplateDynastyReason } from "./template-dynasties.js";

/** A version the build never measured: the dynasty's noun and return, no figure. */
function unmeasuredVersion(row: CatalogTemplate, key: string): CatalogTemplateVersion {
  const sibling = row.versions[0];
  const exposure = sibling?.emailsNoun ?? row.emailsNoun;
  const outcomeNoun = /^[\d,.]+ (.+?) · /.exec(row.sample)?.[1] ?? "outcomes";
  return {
    key,
    label: templateLabel(key),
    head: false,
    hasText: false,
    status: null,
    rank: null,
    rankBasis: "cost_per_outcome",
    emails: n(0),
    emailsNoun: exposure,
    outcomes: n(0),
    spend: usd(0),
    cost: null,
    rate: null,
    thin: true,
    sample: `${n(0)} ${outcomeNoun} · ${n(0)} ${exposure}`,
    charts: [],
    ...(row.roiDetail.value != null
      ? { roi: row.roiDetail.display, roiDetail: { ...row.roiDetail, basis: "expected" as const, source: "dynasty" as const, spendCovered: null } }
      : { roi: row.roi, roiDetail: row.roiDetail }),
  };
}

/** PURE. The template rows with content-generation's current status, head and version statuses laid over the build's. */
export function withLiveTemplateStatus(rows: readonly CatalogTemplate[], live: readonly TemplateDynasty[] | TemplateDynastyReason | null): CatalogTemplate[] {
  if (live === null || typeof live === "string") return [...rows];
  const bySlug = new Map(live.map((d) => [d.slug, d]));
  return rows.map((row) => {
    const d = row.dynasty ? bySlug.get(row.dynasty.slug) : undefined;
    if (!d || !row.dynasty) return row;
    const built = new Map(row.versions.map((v) => [v.key, v]));
    const versions = [
      ...d.versions.map((key) => ({ ...(built.get(key) ?? unmeasuredVersion(row, key)), head: key === d.head, status: d.versionStatuses[key] ?? null })),
      // A version the build listed that content-generation no longer lists stays (its figures are real), as it was.
      ...row.versions.filter((v) => !d.versions.includes(v.key)),
    ];
    return {
      ...row,
      dynasty: { ...row.dynasty, head: d.head ? { key: d.head, label: templateLabel(d.head) } : null },
      status: d.status,
      statusSource: d.statusSource,
      statusUnavailableReason: d.status === null ? "status_not_stated" : null,
      versions,
    };
  });
}
