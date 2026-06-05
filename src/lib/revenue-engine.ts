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
 *     campaign rows is ONE person; their signals are OR'd across rows, signal dates
 *     keep the earliest (MIN) across rows.
 *   - orgs dedup on organization id; a person with no org is their own singleton org.
 *
 * Only persons with EV > 0 (at least one signal fired) enter the tables and the total
 * — an un-engaged served lead is not pipeline.
 *
 * Dates (optional — populated once per-event timestamps are available from email-gateway):
 *   - each fired signal carries an event date (`signalDates[signal]`);
 *   - an entity's date is the MOST-ADVANCED (max) of its fired-event dates;
 *   - the time-series cumulates org EV ordered by org event date (undated orgs are
 *     still in the headline total but cannot be placed on the timeline — no silent drop,
 *     they are simply absent from the series).
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
  /** Recipient email — used by the route to join per-event timestamps; ignored by the engine. */
  email?: string | null;
  /** Which funnel signals fired for this person (e.g. { clicked: true, positiveReply: false }). */
  signals: Record<string, boolean>;
  /** ISO timestamp of each signal's first occurrence, when known (null otherwise). */
  signalDates?: Record<string, string | null>;
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
  /** Most-advanced (max) event date for the org. Null when no event date is known. */
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
  /** Most-advanced (max) event date for the lead. Null when no event date is known. */
  date: string | null;
}

export interface TimeSeriesPoint {
  date: string;
  cumulativePipelineUsd: number;
}

export interface EventRow {
  leadId: string;
  person: string | null;
  org: string | null;
  eventType: string;
  eventDate: string;
  contributionUsd: number;
}

export interface RevenueResult {
  headline: { totalPipelineUsd: number };
  timeSeries: TimeSeriesPoint[];
  organizations: OrganizationRow[];
  leads: LeadRow[];
  events: EventRow[];
}

interface FiredEvent {
  tag: string;
  eventDate: string | null;
  contributionUsd: number;
}

interface PersonEv {
  person: EnginePerson;
  ev: number;
  tags: string[];
  /** Most-advanced (max) date among fired events; null if none dated. */
  date: string | null;
  firedEvents: FiredEvent[];
}

/** Latest (max) of two ISO timestamps; nulls ignored. ISO-8601 sorts lexicographically. */
function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** Earliest (min) of two ISO timestamps; nulls ignored. */
function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function personName(p: EnginePerson): string | null {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return name.length > 0 ? name : null;
}

/** Merge per-campaign rows of the same lead into one person; OR signals, MIN signal dates. */
function dedupPersonsByLead(rows: EnginePerson[]): EnginePerson[] {
  const byLead = new Map<string, EnginePerson>();
  for (const row of rows) {
    const existing = byLead.get(row.leadId);
    if (!existing) {
      byLead.set(row.leadId, { ...row, signals: { ...row.signals }, signalDates: { ...(row.signalDates ?? {}) } });
      continue;
    }
    for (const [key, value] of Object.entries(row.signals)) {
      existing.signals[key] = Boolean(existing.signals[key]) || value;
    }
    if (row.signalDates) {
      existing.signalDates = existing.signalDates ?? {};
      for (const [key, value] of Object.entries(row.signalDates)) {
        existing.signalDates[key] = minDate(existing.signalDates[key] ?? null, value ?? null);
      }
    }
    if (!existing.orgId && row.orgId) {
      existing.orgId = row.orgId;
      existing.orgName = row.orgName;
      existing.orgLogoUrl = row.orgLogoUrl;
    }
  }
  return [...byLead.values()];
}

/** Per-person EV = MAX over fired paths; tags = union; date = max fired-event date. */
function evForPerson(person: EnginePerson, paths: ResolvedPath[]): PersonEv {
  let ev = 0;
  const tags: string[] = [];
  const firedEvents: FiredEvent[] = [];
  let date: string | null = null;
  for (const path of paths) {
    if (!person.signals[path.signal]) continue;
    if (!tags.includes(path.tag)) tags.push(path.tag);
    if (path.expectedRevenueUsd > ev) ev = path.expectedRevenueUsd;
    const eventDate = person.signalDates?.[path.signal] ?? null;
    firedEvents.push({ tag: path.tag, eventDate, contributionUsd: path.expectedRevenueUsd });
    date = maxDate(date, eventDate);
  }
  return { person, ev, tags, date, firedEvents };
}

export function computeRevenue(paths: ResolvedPath[], rawPersons: EnginePerson[]): RevenueResult {
  const persons = dedupPersonsByLead(rawPersons);

  // Score every person, keep only those actually in the pipeline (EV > 0).
  const scored = persons
    .map((person) => evForPerson(person, paths))
    .filter((p) => p.ev > 0);

  // Leads table — one row per engaged person, person-level EV.
  const leads: LeadRow[] = scored.map(({ person, ev, tags, date }) => ({
    leadId: person.leadId,
    firstName: person.firstName,
    lastName: person.lastName,
    photoUrl: person.photoUrl,
    orgName: person.orgName,
    orgLogoUrl: person.orgLogoUrl,
    tags,
    expectedRevenueUsd: ev,
    date,
  }));
  leads.sort((a, b) => b.expectedRevenueUsd - a.expectedRevenueUsd);

  // Events table — one row per fired, dated event.
  const events: EventRow[] = [];
  for (const entry of scored) {
    for (const ev of entry.firedEvents) {
      if (!ev.eventDate) continue; // can't place an undated event on the ledger
      events.push({
        leadId: entry.person.leadId,
        person: personName(entry.person),
        org: entry.person.orgName,
        eventType: ev.tag,
        eventDate: ev.eventDate,
        contributionUsd: ev.contributionUsd,
      });
    }
  }
  events.sort((a, b) => (a.eventDate < b.eventDate ? -1 : a.eventDate > b.eventDate ? 1 : 0));

  // Organizations — dedup on org id (no org → singleton keyed by leadId).
  // MAX person EV inside the org; union of tags; argmax person = topPerson; max member date.
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
    let orgDate: string | null = null;
    for (const entry of bucket) {
      if (entry.ev > top.ev) top = entry;
      for (const tag of entry.tags) if (!tags.includes(tag)) tags.push(tag);
      orgDate = maxDate(orgDate, entry.date);
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
      mostAdvancedDate: orgDate,
    });
  }
  organizations.sort((a, b) => b.expectedRevenueUsd - a.expectedRevenueUsd);

  // Time series — cumulate org EV ordered by org event date. Undated orgs are absent
  // from the series (still counted in the headline total — no silent inflation).
  const dated = organizations
    .filter((o) => o.mostAdvancedDate !== null)
    .map((o) => ({ date: o.mostAdvancedDate as string, ev: o.expectedRevenueUsd }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const timeSeries: TimeSeriesPoint[] = [];
  let cumulative = 0;
  for (const o of dated) {
    cumulative += o.ev;
    timeSeries.push({ date: o.date, cumulativePipelineUsd: cumulative });
  }

  return { headline: { totalPipelineUsd }, timeSeries, organizations, leads, events };
}
