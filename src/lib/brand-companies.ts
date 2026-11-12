/**
 * The brand's companies, PAGED and SLIM (MON-PAGE-SPEED-2-1112, owner goal: every dashboard page instant).
 *
 * The dashboard's Companies page, a Company page and the search palette read the brand revenue body for its
 * `organizations[]`: 7.1 MB on our own brand (11,345 companies, prod 2026-11-12), plus the brand company
 * lifecycle body (2.0 MB) for each company's rung. Both are over the browser's 2 MB persisted-cache cap, so
 * those pages reloaded ~9 MB on every visit. This module derives ONE index per stored pair of bodies and
 * answers a page of rows, one company, or a search out of it: the rows are the stored rows, field for field
 * (minus `orgLogoUrl`, which no reader draws), each joined to its served lifecycle rung. Nothing is recomputed:
 * the order, the filter and the page are the only work done here.
 *
 * PURE: no I/O. `routes/brand-companies.ts` reads the two stored bodies and memoizes the index per body.
 */

export interface CompanyLifecycleRef {
  key: string;
  rank: number;
  label: string;
}

/** A brand revenue `organizations[]` row, as the stored body carries it. */
export interface StoredCompany {
  organizationKey: string;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl?: string | null;
  orgDomain: string | null;
  topPerson: { firstName: string | null; lastName: string | null; photoUrl: string | null } | null;
  peopleCount: number;
  tags: string[];
  expectedRevenueUsd: number;
  mostAdvancedDate: string | null;
}

/** The served row: the stored row without its logo, with its lifecycle rung (null = on no rung, or no lifecycle). */
export interface CompanyRow {
  organizationKey: string;
  /** The key a Company page is addressed by: the domain when known, else the org id; null = no page. */
  companyKey: string | null;
  orgId: string | null;
  orgName: string | null;
  orgDomain: string | null;
  topPerson: StoredCompany["topPerson"];
  peopleCount: number;
  tags: string[];
  expectedRevenueUsd: number;
  mostAdvancedDate: string | null;
  lifecycle: CompanyLifecycleRef | null;
}

export interface CompanyRung extends CompanyLifecycleRef {
  organizationCount: number;
}

/** The brand company lifecycle body, as much of it as this module reads. */
export interface StoredLifecycle {
  rungs: Array<CompanyLifecycleRef & { organizationCount: number }>;
  organizations: Array<{ organizationKey: string; lifecycle: CompanyLifecycleRef | null }>;
}

export const COMPANY_SORTS = ["value", "touch", "name"] as const;
export type CompanySort = (typeof COMPANY_SORTS)[number];

export interface CompanyIndex {
  /** Every row, highest expected value first (ties keep the stored order). */
  byValue: CompanyRow[];
  /** Positions in `byValue`, per sort. */
  order: Record<CompanySort, number[]>;
  /** Lower-cased "name domain" per `byValue` position: what a search term is matched against. */
  haystack: string[];
  /** First `byValue` position of each company key. */
  positionOfKey: Map<string, number>;
  rungs: CompanyRung[];
}

/** The URL key of a company: its domain when served, else its org id (the dashboard's `companyKey`). */
export function companyKeyOf(o: Pick<StoredCompany, "orgDomain" | "orgId">): string | null {
  return o.orgDomain ?? o.orgId ?? null;
}

function slim(o: StoredCompany, lifecycle: CompanyLifecycleRef | null): CompanyRow {
  return {
    organizationKey: o.organizationKey,
    companyKey: companyKeyOf(o),
    orgId: o.orgId,
    orgName: o.orgName,
    orgDomain: o.orgDomain,
    topPerson: o.topPerson,
    peopleCount: o.peopleCount,
    tags: o.tags,
    expectedRevenueUsd: o.expectedRevenueUsd,
    mostAdvancedDate: o.mostAdvancedDate,
    lifecycle: lifecycle ? { key: lifecycle.key, rank: lifecycle.rank, label: lifecycle.label } : null,
  };
}

const SORT_COMPARE: Record<CompanySort, (a: CompanyRow, b: CompanyRow) => number> = {
  value: (a, b) => b.expectedRevenueUsd - a.expectedRevenueUsd,
  touch: (a, b) => (b.mostAdvancedDate ?? "").localeCompare(a.mostAdvancedDate ?? ""),
  name: (a, b) => (a.orgName ?? a.orgDomain ?? "").localeCompare(b.orgName ?? b.orgDomain ?? ""),
};

/** Build the index once per stored pair of bodies. `lifecycle` null = the brand has no lifecycle (no offer campaign). */
export function buildCompanyIndex(organizations: readonly StoredCompany[], lifecycle: StoredLifecycle | null): CompanyIndex {
  const rungOf = new Map((lifecycle?.organizations ?? []).map((o) => [o.organizationKey, o.lifecycle]));
  const stored = organizations.map((o) => slim(o, rungOf.get(o.organizationKey) ?? null));
  // Array.prototype.sort is stable: ties keep the stored order, as the page's own sort did.
  const byValue = [...stored].sort(SORT_COMPARE.value);
  const positions = byValue.map((_, i) => i);
  const order = {
    value: positions,
    touch: [...positions].sort((a, b) => SORT_COMPARE.touch(byValue[a], byValue[b]) || a - b),
    name: [...positions].sort((a, b) => SORT_COMPARE.name(byValue[a], byValue[b]) || a - b),
  };
  const positionOfKey = new Map<string, number>();
  byValue.forEach((o, i) => {
    if (o.companyKey && !positionOfKey.has(o.companyKey)) positionOfKey.set(o.companyKey, i);
  });
  return {
    byValue,
    order,
    haystack: byValue.map((o) => `${o.orgName ?? ""} ${o.orgDomain ?? ""}`.toLowerCase()),
    positionOfKey,
    rungs: (lifecycle?.rungs ?? []).map((r) => ({ key: r.key, rank: r.rank, label: r.label, organizationCount: r.organizationCount })),
  };
}

export interface CompanyPageQuery {
  sort: CompanySort;
  /** Every whitespace-separated word must appear in the company's name or domain (case-insensitive). */
  q: string | null;
  /** A lifecycle rung key: only the companies standing on it. */
  rung: string | null;
  offset: number;
  limit: number;
}

/** One page of rows in the asked order, and how many rows match the filter. */
export function pageCompanies(index: CompanyIndex, query: CompanyPageQuery): { total: number; companies: CompanyRow[] } {
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (i: number) =>
    (query.rung === null || index.byValue[i].lifecycle?.key === query.rung) && words.every((w) => index.haystack[i].includes(w));
  const filtered = words.length === 0 && query.rung === null ? index.order[query.sort] : index.order[query.sort].filter(matches);
  return { total: filtered.length, companies: filtered.slice(query.offset, query.offset + query.limit).map((i) => index.byValue[i]) };
}

/** One company by its URL key, its 1-based place in the value order, and its neighbours' keys (a Company page's j/k). */
export function oneCompany(
  index: CompanyIndex,
  key: string,
): { company: CompanyRow; position: number; previousKey: string | null; nextKey: string | null } | null {
  const at = index.positionOfKey.get(key);
  if (at === undefined) return null;
  return {
    company: index.byValue[at],
    position: at + 1,
    previousKey: at > 0 ? index.byValue[at - 1].companyKey : null,
    nextKey: at < index.byValue.length - 1 ? index.byValue[at + 1].companyKey : null,
  };
}

export const COMPANY_PAGE_DEFAULT_LIMIT = 60;
export const COMPANY_PAGE_MAX_LIMIT = 5000;

/** Parse the list query; a refusal names the parameter. */
export function parseCompanyPageQuery(raw: Record<string, unknown>): CompanyPageQuery | { error: string; reason: string } {
  const sort = raw.sort === undefined ? "value" : raw.sort;
  if (typeof sort !== "string" || !(COMPANY_SORTS as readonly string[]).includes(sort)) {
    return { error: `sort must be one of: ${COMPANY_SORTS.join(", ")}`, reason: "sort_unrecognised" };
  }
  const int = (v: unknown, fallback: number): number | null => {
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
    return Number(v);
  };
  const offset = int(raw.offset, 0);
  if (offset === null) return { error: "offset must be a non-negative integer", reason: "offset_invalid" };
  const limit = int(raw.limit, COMPANY_PAGE_DEFAULT_LIMIT);
  if (limit === null || limit < 1 || limit > COMPANY_PAGE_MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${COMPANY_PAGE_MAX_LIMIT}`, reason: "limit_invalid" };
  }
  if (raw.q !== undefined && typeof raw.q !== "string") return { error: "q must be a string", reason: "q_invalid" };
  if (raw.rung !== undefined && (typeof raw.rung !== "string" || raw.rung === "")) {
    return { error: "rung must be a lifecycle rung key", reason: "rung_invalid" };
  }
  const q = typeof raw.q === "string" && raw.q.trim() !== "" ? raw.q.trim() : null;
  return { sort: sort as CompanySort, q, rung: (raw.rung as string | undefined) ?? null, offset, limit };
}
