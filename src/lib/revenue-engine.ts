/**
 * Generic expected-pipeline-revenue engine.
 *
 * Funnel-agnostic: it knows nothing about sales, press, hiring, etc. The caller
 * resolves a feature's funnel into numeric `ResolvedPath[]` (each path = a signal
 * that, when fired, contributes a precomputed expected-revenue amount) and a flat
 * list of per-row persons. The engine then applies the universal rule:
 *
 *   - MAX inside an entity  — a person's EV is the max over the paths whose signal
 *     fired; an org's EV is the max person EV across the org (1 org = 1 client = 1 LTR).
 *   - SUM between entities   — total pipeline = sum of org EV over DISTINCT orgs.
 *
 * Dedup keys (see global identity-keying note):
 *   - persons dedup on the ATOMIC member (leadId) — one lead surfacing under several
 *     campaign rows is ONE person; their signals are OR'd across rows.
 *   - orgs dedup on organization id; a person with no org is their own singleton org.
 *
 * Only persons with EV > 0 (at least one signal fired) enter the tables and the total
 * — an un-engaged served lead is not pipeline.
 */

export interface ResolvedPath {
  /** Conversion-type tag surfaced to the UI (e.g. "visit", "reply"). */
  tag: string;
  /** Key into a person's `signals` map that triggers this path. */
  signal: string;
  /** LTR × rate-chain — the expected revenue this path contributes when its signal fired. */
  expectedRevenueUsd: number;
}

export interface EnginePerson {
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  /** Which funnel signals fired for this person (e.g. { clicked: true, positiveReply: false }). */
  signals: Record<string, boolean>;
}

export interface TopPerson {
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
}

export interface OrganizationRow {
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  topPerson: TopPerson;
  tags: string[];
  expectedRevenueUsd: number;
  /** Most-advanced event date for the org. Null until per-event timestamps exist (email-gateway). */
  mostAdvancedDate: string | null;
}

export interface LeadRow {
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  tags: string[];
  expectedRevenueUsd: number;
  /** Most-advanced event date for the lead. Null until per-event timestamps exist (email-gateway). */
  date: string | null;
}

export interface RevenueResult {
  headline: { totalPipelineUsd: number };
  organizations: OrganizationRow[];
  leads: LeadRow[];
}

interface PersonEv {
  person: EnginePerson;
  ev: number;
  tags: string[];
}

/** Merge per-campaign rows of the same lead into one person; OR their signals. */
function dedupPersonsByLead(rows: EnginePerson[]): EnginePerson[] {
  const byLead = new Map<string, EnginePerson>();
  for (const row of rows) {
    const existing = byLead.get(row.leadId);
    if (!existing) {
      byLead.set(row.leadId, { ...row, signals: { ...row.signals } });
      continue;
    }
    for (const [key, value] of Object.entries(row.signals)) {
      existing.signals[key] = Boolean(existing.signals[key]) || value;
    }
    // Backfill org identity if an earlier row lacked it.
    if (!existing.orgId && row.orgId) {
      existing.orgId = row.orgId;
      existing.orgName = row.orgName;
      existing.orgLogoUrl = row.orgLogoUrl;
    }
  }
  return [...byLead.values()];
}

/** Per-person expected value = MAX over the paths whose signal fired; tags = union of those fired. */
function evForPerson(person: EnginePerson, paths: ResolvedPath[]): PersonEv {
  let ev = 0;
  const tags: string[] = [];
  for (const path of paths) {
    if (person.signals[path.signal]) {
      if (!tags.includes(path.tag)) tags.push(path.tag);
      if (path.expectedRevenueUsd > ev) ev = path.expectedRevenueUsd;
    }
  }
  return { person, ev, tags };
}

export function computeRevenue(paths: ResolvedPath[], rawPersons: EnginePerson[]): RevenueResult {
  const persons = dedupPersonsByLead(rawPersons);

  // Score every person, keep only those that are actually in the pipeline (EV > 0).
  const scored = persons
    .map((person) => evForPerson(person, paths))
    .filter((p) => p.ev > 0);

  // Leads table — one row per engaged person, person-level EV.
  const leads: LeadRow[] = scored.map(({ person, ev, tags }) => ({
    leadId: person.leadId,
    firstName: person.firstName,
    lastName: person.lastName,
    photoUrl: person.photoUrl,
    orgName: person.orgName,
    orgLogoUrl: person.orgLogoUrl,
    tags,
    expectedRevenueUsd: ev,
    date: null,
  }));
  leads.sort((a, b) => b.expectedRevenueUsd - a.expectedRevenueUsd);

  // Organizations table — dedup on org id (no org → singleton keyed by leadId).
  // MAX person EV inside the org; union of tags; argmax person = topPerson.
  const byOrg = new Map<string, PersonEv[]>();
  for (const entry of scored) {
    const key = entry.person.orgId ?? `lead:${entry.person.leadId}`;
    const bucket = byOrg.get(key);
    if (bucket) bucket.push(entry);
    else byOrg.set(key, [entry]);
  }

  const organizations: OrganizationRow[] = [];
  let totalPipelineUsd = 0;
  for (const bucket of byOrg.values()) {
    let top = bucket[0];
    const tags: string[] = [];
    for (const entry of bucket) {
      if (entry.ev > top.ev) top = entry;
      for (const tag of entry.tags) if (!tags.includes(tag)) tags.push(tag);
    }
    const orgEv = top.ev; // MAX inside the org
    totalPipelineUsd += orgEv; // SUM between distinct orgs
    organizations.push({
      orgId: top.person.orgId,
      orgName: top.person.orgName,
      orgLogoUrl: top.person.orgLogoUrl,
      topPerson: {
        firstName: top.person.firstName,
        lastName: top.person.lastName,
        photoUrl: top.person.photoUrl,
      },
      tags,
      expectedRevenueUsd: orgEv,
      mostAdvancedDate: null,
    });
  }
  organizations.sort((a, b) => b.expectedRevenueUsd - a.expectedRevenueUsd);

  return { headline: { totalPipelineUsd }, organizations, leads };
}
