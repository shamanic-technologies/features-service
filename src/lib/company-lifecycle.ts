/**
 * WHERE EACH ORGANISATION AN OFFER REACHED STANDS ON THE ONE LIFECYCLE LADDER (owner 2026-10-21, DEALS-LIFECYCLE-1021):
 * the customer's Companies page lists the organisations the offer reached and tabs them by rung. An organisation's
 * rung is the HIGHEST rung any of its people reached; a person's rung is lead-service's served lifecycle (its Unibox
 * row's `lifecycle`), read, never recomputed here from raw signals. No second ladder: `lib/lifecycle-ladder.ts`.
 *
 * WHO the organisations are: the scope's lead population grouped exactly as the offer's revenue read groups its
 * `organizations[]` (`organizationKeyOf`: the company, else the lead alone), joined on `organizationKey`. Every
 * company is listed; a company-less lead is listed only when it stands on a rung (the revenue read lists one only
 * when it is worth something). An organisation none of whose people stands on a rung reads `lifecycle: null`
 * (counted in `noRungOrganizationCount`), never a guessed rung.
 *
 * The per-rung counts partition the organisations: each counts ONCE, on its highest rung, so
 * Σ `rungs[].organizationCount` + `noRungOrganizationCount` = `organizationCount`. (The lifecycle Deals board counts
 * an organisation on EVERY rung one of its people stands on, so its per-rung counts can exceed these.)
 */
import { LIFECYCLE_RUNGS, type LifecycleRungKey } from "./lifecycle-ladder.js";
import { organizationKeyOf } from "./revenue-engine.js";

export interface CompanyLifecycleRung {
  key: LifecycleRungKey;
  rank: number;
  label: string;
}

export interface CompanyLifecycleRow {
  /** `org:<orgId>`, or `lead:<leadId>` for a company-less lead: the revenue read's `organizations[].organizationKey`. */
  organizationKey: string;
  /** The company; null for a company-less lead. */
  orgId: string | null;
  /** The highest rung any of its people reached; null = none of them stands on a rung. */
  lifecycle: CompanyLifecycleRung | null;
}

export interface CompanyLifecycleResult {
  columns: "company_lifecycle";
  /** Organisations listed: every company of the scope's population, plus each company-less lead on a rung. */
  organizationCount: number;
  /** Of them, company-less leads. */
  withoutCompanyCount: number;
  /** Organisations none of whose people stands on a rung. */
  noRungOrganizationCount: number;
  /** Every rung of the ladder, in order, always all seven: how many organisations stand on it (their highest rung). */
  rungs: Array<CompanyLifecycleRung & { organizationCount: number; withoutCompanyCount: number }>;
  /** One row per organisation, highest rung first, then organizationKey. */
  organizations: CompanyLifecycleRow[];
  /** Unibox rows on a rung none of whose leads this scope holds (people of the brand, not of this scope). */
  outOfScopeRowCount: number;
}

/** One Unibox row, as this read needs it. */
export interface CompanyLifecycleUniboxRow {
  leadIds: readonly string[];
  /** lead-service's served lifecycle rung key. */
  rung: string;
}

const RUNG_BY_KEY = new Map<string, CompanyLifecycleRung>(LIFECYCLE_RUNGS.map((r) => [r.key, { key: r.key, rank: r.rank, label: r.label }]));

/** PURE. Each organisation's highest rung and the per-rung organisation counts. */
export function companyLifecycles(input: {
  /** The scope's lead population (deduped by lead): each lead and its company (`orgId`, null = no company). */
  persons: ReadonlyArray<{ leadId: string; orgId: string | null }>;
  rows: readonly CompanyLifecycleUniboxRow[];
}): CompanyLifecycleResult {
  const keyOfLead = new Map<string, { key: string; orgId: string | null }>();
  const best = new Map<string, { orgId: string | null; rung: CompanyLifecycleRung | null }>();
  for (const p of input.persons) {
    const key = organizationKeyOf(p);
    keyOfLead.set(p.leadId, { key, orgId: p.orgId });
    if (p.orgId != null && !best.has(key)) best.set(key, { orgId: p.orgId, rung: null });
  }

  let outOfScopeRowCount = 0;
  for (const row of input.rows) {
    const rung = RUNG_BY_KEY.get(row.rung);
    if (!rung) throw new Error(`company lifecycle: lead-service served an unknown lifecycle rung "${row.rung}"`);
    const held = row.leadIds.filter((id) => keyOfLead.has(id));
    if (held.length === 0) {
      outOfScopeRowCount += 1;
      continue;
    }
    for (const id of held) {
      const { key, orgId } = keyOfLead.get(id)!;
      const current = best.get(key)?.rung ?? null;
      if (current === null || rung.rank > current.rank) best.set(key, { orgId, rung });
    }
  }

  const organizations: CompanyLifecycleRow[] = [...best.entries()]
    .map(([organizationKey, b]) => ({ organizationKey, orgId: b.orgId, lifecycle: b.rung }))
    .sort(
      (a, b) =>
        (b.lifecycle?.rank ?? 0) - (a.lifecycle?.rank ?? 0) ||
        (a.organizationKey < b.organizationKey ? -1 : a.organizationKey > b.organizationKey ? 1 : 0),
    );
  const countByKey = new Map<string, { all: number; noCompany: number }>();
  let noRung = 0;
  for (const o of organizations) {
    if (o.lifecycle === null) {
      noRung += 1;
      continue;
    }
    const c = countByKey.get(o.lifecycle.key) ?? { all: 0, noCompany: 0 };
    c.all += 1;
    if (o.orgId === null) c.noCompany += 1;
    countByKey.set(o.lifecycle.key, c);
  }
  return {
    columns: "company_lifecycle",
    organizationCount: organizations.length,
    withoutCompanyCount: organizations.filter((o) => o.orgId === null).length,
    noRungOrganizationCount: noRung,
    rungs: LIFECYCLE_RUNGS.map((r) => ({
      key: r.key,
      rank: r.rank,
      label: r.label,
      organizationCount: countByKey.get(r.key)?.all ?? 0,
      withoutCompanyCount: countByKey.get(r.key)?.noCompany ?? 0,
    })),
    organizations,
    outOfScopeRowCount,
  };
}
