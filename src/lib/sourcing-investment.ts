/**
 * WHAT WE PAID TO SOURCE A BRAND'S PEOPLE — the staff "$ invested" figures of the Audience page.
 *
 * Not outreach: what it cost to put a person (or a company list) INTO an audience. Two kinds of spend
 * count, both read from runs-service, never guessed from cost names:
 *   - SERVE spend: the whole cost subtree of every `lead-service:lead-serve` run of the brand. A serve
 *     is the act of acquiring one person: the Jev pre-pay screens of the candidates it looked at, the
 *     provider reveal / enrichment, email finding and verification, the LinkedIn engagement and
 *     buying-signal reads. Its subtree is exact attribution (parent links), not a cost-name list.
 *   - LIST-BUILD spend: `apollo-service:audience-companies`, the company lists pulled when an audience
 *     is built or previewed. It never runs under a serve (checked fleet-wide 2026-10-05), so the two
 *     kinds never overlap.
 * Not counted: email writing / sending / reply reading (outreach, the audience-stats figure), brand
 * and offer setup, the LLM audience split and the three-company email pre-check of an audience preview.
 *
 * Grains, all on committed (`actual`) cost rows, since inception:
 *   - audience: serve runs by the audience the serve was made from + list-build by its audience;
 *   - person: the serve runs lead-service recorded as having handed that person out (one person can be
 *     served by several campaigns: every one of those serves counts);
 *   - company: the sum over its people (keyed on the company's domain).
 * A serve that handed out nobody (every candidate screened out, or a failed reveal) is real sourcing
 * spend of its audience that no person carries: it is stated as `notOnAPerson`, never spread.
 *
 * Bases: BILLED (what the org is charged at list price, before its usage discount) and VENDOR (what
 * the rows cost us from the provider, before markup; null when any row of the figure has no known
 * vendor cost, with that billed amount named). Exact decimal sums on the producer's text.
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { addDecimals, decimalCentsToUsd } from "./decimal.js";
import type { ServedPersonRow } from "./leads-client.js";

/** One serve run of the brand and its subtree cost (cents, the producer's decimal text). */
export interface ServeRunCost {
  runId: string;
  audienceId: string | null;
  campaignId: string | null;
  billedCents: string;
  vendorCents: string;
  unpricedBilledCents: string;
}

/** List-build spend of one audience (null = carried no audience). */
export interface ListBuildCost {
  audienceId: string | null;
  billedCents: string;
  vendorCents: string;
  unpricedBilledCents: string;
}

export interface InvestedMoney {
  /** Billed at list price (before the org's usage discount), USD. */
  billedUsd: number;
  /** What it cost us from the vendor, USD; null when part of it has no known vendor cost. */
  vendorUsd: number | null;
  /** Billed amount of the rows whose vendor cost is unknown (why `vendorUsd` is null), USD. */
  unpricedBilledUsd: number;
}

export interface AudienceInvestment {
  audienceId: string;
  invested: InvestedMoney;
  serves: InvestedMoney;
  listBuild: InvestedMoney;
  /** Serve spend on runs that handed out no person we hold. */
  notOnAPerson: InvestedMoney;
  serveCount: number;
  personCount: number;
  companyCount: number;
}

export interface PersonInvestment {
  leadId: string;
  apolloPersonId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  audienceIds: string[];
  serveCount: number;
  invested: InvestedMoney;
}

export interface CompanyInvestment {
  companyDomain: string;
  companyName: string | null;
  personCount: number;
  audienceIds: string[];
  invested: InvestedMoney;
}

export interface SourcingInvestment {
  total: InvestedMoney;
  serves: InvestedMoney;
  listBuild: InvestedMoney;
  notOnAPerson: InvestedMoney;
  /** Spend carrying no audience (serves or list-build): in `total`, in no audience row. */
  withoutAudience: InvestedMoney;
  /** People whose company domain is unknown: in `people`, in no company row. */
  peopleWithoutCompanyDomain: { personCount: number; invested: InvestedMoney };
  serveCount: number;
  servesWithoutPerson: number;
  personCount: number;
  companyCount: number;
  audiences: AudienceInvestment[];
  people: PersonInvestment[];
  companies: CompanyInvestment[];
}

interface Acc {
  billed: string;
  vendor: string;
  unpriced: string;
}

const zero = (): Acc => ({ billed: "0", vendor: "0", unpriced: "0" });

function add(acc: Acc, c: { billedCents: string; vendorCents: string; unpricedBilledCents: string }): void {
  acc.billed = addDecimals(acc.billed, c.billedCents);
  acc.vendor = addDecimals(acc.vendor, c.vendorCents);
  acc.unpriced = addDecimals(acc.unpriced, c.unpricedBilledCents);
}

function addAcc(acc: Acc, o: Acc): void {
  acc.billed = addDecimals(acc.billed, o.billed);
  acc.vendor = addDecimals(acc.vendor, o.vendor);
  acc.unpriced = addDecimals(acc.unpriced, o.unpriced);
}

function money(acc: Acc): InvestedMoney {
  const unpricedBilledUsd = decimalCentsToUsd(acc.unpriced);
  return {
    billedUsd: decimalCentsToUsd(acc.billed),
    vendorUsd: unpricedBilledUsd === 0 ? decimalCentsToUsd(acc.vendor) : null,
    unpricedBilledUsd,
  };
}

/** Pure: the three grains from the serve runs, the list-build groups and lead-service's serve rows. */
export function computeSourcingInvestment(input: {
  serves: ServeRunCost[];
  listBuild: ListBuildCost[];
  servedRows: ServedPersonRow[];
}): SourcingInvestment {
  const serveById = new Map<string, ServeRunCost>();
  for (const s of input.serves) serveById.set(s.runId, s);

  // Which person each serve handed out. A serve run hands out one person; if lead-service ever
  // recorded two rows on one run, the run is counted ONCE (on the first person) so no cent is doubled.
  const personOfRun = new Map<string, string>();
  const rowsByLead = new Map<string, ServedPersonRow[]>();
  for (const row of input.servedRows) {
    if (!serveById.has(row.runId)) continue; // not one of the brand's serve runs: no sourcing cost known
    if (!personOfRun.has(row.runId)) personOfRun.set(row.runId, row.leadId);
    const list = rowsByLead.get(row.leadId) ?? [];
    list.push(row);
    rowsByLead.set(row.leadId, list);
  }

  const total = zero();
  const serves = zero();
  const listBuild = zero();
  const notOnAPerson = zero();
  const withoutAudience = zero();
  interface AudAcc { serves: Acc; listBuild: Acc; notOnAPerson: Acc; serveCount: number; persons: Set<string>; companies: Set<string> }
  const audiences = new Map<string, AudAcc>();
  const aud = (id: string): AudAcc => {
    let a = audiences.get(id);
    if (!a) {
      a = { serves: zero(), listBuild: zero(), notOnAPerson: zero(), serveCount: 0, persons: new Set(), companies: new Set() };
      audiences.set(id, a);
    }
    return a;
  };

  let servesWithoutPerson = 0;
  for (const s of input.serves) {
    add(total, s);
    add(serves, s);
    const onPerson = personOfRun.has(s.runId);
    if (!onPerson) {
      add(notOnAPerson, s);
      servesWithoutPerson += 1;
    }
    if (s.audienceId === null) {
      add(withoutAudience, s);
      continue;
    }
    const a = aud(s.audienceId);
    add(a.serves, s);
    a.serveCount += 1;
    if (!onPerson) add(a.notOnAPerson, s);
  }
  for (const g of input.listBuild) {
    add(total, g);
    add(listBuild, g);
    if (g.audienceId === null) add(withoutAudience, g);
    else add(aud(g.audienceId).listBuild, g);
  }

  const people: PersonInvestment[] = [];
  const personAcc = new Map<string, Acc>();
  for (const [leadId, rows] of rowsByLead) {
    const acc = zero();
    const runIds = new Set<string>();
    const audienceIds = new Set<string>();
    for (const row of rows) {
      if (personOfRun.get(row.runId) !== leadId || runIds.has(row.runId)) continue;
      runIds.add(row.runId);
      const serve = serveById.get(row.runId)!;
      add(acc, serve);
      // The audience the SERVE was made from (runs-service), which is what the audience figure keys on.
      if (serve.audienceId) audienceIds.add(serve.audienceId);
    }
    if (runIds.size === 0) continue;
    const first = rows[0]!;
    const withCompany = rows.find((r) => r.companyDomain) ?? first;
    people.push({
      leadId,
      apolloPersonId: rows.find((r) => r.apolloPersonId)?.apolloPersonId ?? null,
      email: rows.find((r) => r.email)?.email ?? null,
      firstName: first.firstName,
      lastName: first.lastName,
      companyName: withCompany.companyName,
      companyDomain: withCompany.companyDomain,
      audienceIds: [...audienceIds].sort(),
      serveCount: runIds.size,
      invested: money(acc),
    });
    for (const a of audienceIds) {
      const row = aud(a);
      row.persons.add(leadId);
      if (withCompany.companyDomain) row.companies.add(withCompany.companyDomain);
    }
    personAcc.set(leadId, acc);
  }

  const companiesByDomain = new Map<string, { name: string | null; persons: number; audienceIds: Set<string>; acc: Acc }>();
  const noDomain = { personCount: 0, acc: zero() };
  for (const p of people) {
    const acc = personAcc.get(p.leadId)!;
    if (!p.companyDomain) {
      noDomain.personCount += 1;
      addAcc(noDomain.acc, acc);
      continue;
    }
    const c = companiesByDomain.get(p.companyDomain) ?? { name: p.companyName, persons: 0, audienceIds: new Set<string>(), acc: zero() };
    c.persons += 1;
    if (!c.name && p.companyName) c.name = p.companyName;
    for (const a of p.audienceIds) c.audienceIds.add(a);
    addAcc(c.acc, acc);
    companiesByDomain.set(p.companyDomain, c);
  }

  const byBilledDesc = <T extends { invested: InvestedMoney }>(key: (x: T) => string) => (a: T, b: T) =>
    b.invested.billedUsd - a.invested.billedUsd || key(a).localeCompare(key(b));

  const companies: CompanyInvestment[] = [...companiesByDomain].map(([companyDomain, c]) => ({
    companyDomain,
    companyName: c.name,
    personCount: c.persons,
    audienceIds: [...c.audienceIds].sort(),
    invested: money(c.acc),
  }));

  const audienceRows: AudienceInvestment[] = [...audiences].map(([audienceId, a]) => {
    const invested = zero();
    addAcc(invested, a.serves);
    addAcc(invested, a.listBuild);
    return {
      audienceId,
      invested: money(invested),
      serves: money(a.serves),
      listBuild: money(a.listBuild),
      notOnAPerson: money(a.notOnAPerson),
      serveCount: a.serveCount,
      personCount: a.persons.size,
      companyCount: a.companies.size,
    };
  });

  return {
    total: money(total),
    serves: money(serves),
    listBuild: money(listBuild),
    notOnAPerson: money(notOnAPerson),
    withoutAudience: money(withoutAudience),
    peopleWithoutCompanyDomain: { personCount: noDomain.personCount, invested: money(noDomain.acc) },
    serveCount: input.serves.length,
    servesWithoutPerson,
    personCount: people.length,
    companyCount: companies.length,
    audiences: audienceRows.sort(byBilledDesc((x) => x.audienceId)),
    people: people.sort(byBilledDesc((x) => x.leadId)),
    companies: companies.sort(byBilledDesc((x) => x.companyDomain)),
  };
}

// ── runs-service reads (service-auth; the vendor basis reveals our margin) ──────────────────────────

const SERVE_RUN_PAGE = 500;
const MAX_SERVE_RUN_PAGES = 400;

function runsEnv(): { url: string; apiKey: string } {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured");
  return { url, apiKey };
}

interface VendorRunRow {
  id: string;
  audienceId: string | null;
  campaignId: string | null;
  actualCostInUsdCents: string;
  vendorActualCostInUsdCents: string;
  unpricedActualCostInUsdCents: string;
}

/**
 * Every `lead-service:lead-serve` run of the brand with its subtree's committed cost on the billed and
 * vendor bases (runs-service `GET /internal/runs/vendor`, the run list with subtree costs). Paged
 * newest first; a run inserted mid-walk shifts the pages DOWN (a repeat, deduped by id), never a skip.
 */
export async function fetchServeRunCosts(brandId: string, orgId: string): Promise<ServeRunCost[]> {
  const { url, apiKey } = runsEnv();
  const byId = new Map<string, ServeRunCost>();
  for (let page = 0; ; page += 1) {
    if (page >= MAX_SERVE_RUN_PAGES) {
      throw new Error(`runs-service serve-run walk exceeded ${MAX_SERVE_RUN_PAGES} pages for brand ${brandId}`);
    }
    const params = new URLSearchParams({
      orgId,
      brandId,
      serviceName: "lead-service",
      taskName: "lead-serve",
      limit: String(SERVE_RUN_PAGE),
      offset: String(page * SERVE_RUN_PAGE),
    });
    const response = await fetchWithRetry(`${url}/internal/runs/vendor?${params}`, {
      headers: { "x-api-key": apiKey, "x-org-id": orgId },
    });
    if (!response.ok) {
      throw new Error(`runs-service /internal/runs/vendor failed (${response.status}): ${await response.text()}`);
    }
    const data = (await response.json()) as { runs?: VendorRunRow[] };
    if (!Array.isArray(data.runs)) throw new Error("runs-service /internal/runs/vendor returned no runs array");
    for (const r of data.runs) {
      byId.set(r.id, {
        runId: r.id,
        audienceId: r.audienceId ?? null,
        campaignId: r.campaignId ?? null,
        billedCents: r.actualCostInUsdCents,
        vendorCents: r.vendorActualCostInUsdCents,
        unpricedBilledCents: r.unpricedActualCostInUsdCents,
      });
    }
    if (data.runs.length < SERVE_RUN_PAGE) return [...byId.values()];
  }
}

interface VendorGroupRow {
  dimensions: { audienceId?: string | null };
  actualCostInUsdCents: string;
  vendorActualCostInUsdCents: string;
  unpricedActualCostInUsdCents: string;
}

/** The brand's list-build spend (`apollo-service:audience-companies`) per audience, billed + vendor. */
export async function fetchListBuildCosts(brandId: string, orgId: string): Promise<ListBuildCost[]> {
  const { url, apiKey } = runsEnv();
  const params = new URLSearchParams({
    orgId,
    brandId,
    serviceName: "apollo-service",
    taskName: "audience-companies",
    groupBy: "audienceId",
  });
  const response = await fetchWithRetry(`${url}/internal/stats/costs/vendor?${params}`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });
  if (!response.ok) {
    throw new Error(`runs-service /internal/stats/costs/vendor failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { groups?: VendorGroupRow[] };
  if (!Array.isArray(data.groups)) throw new Error("runs-service /internal/stats/costs/vendor returned no groups array");
  return data.groups.map((g) => ({
    audienceId: g.dimensions.audienceId ?? null,
    billedCents: g.actualCostInUsdCents,
    vendorCents: g.vendorActualCostInUsdCents,
    unpricedBilledCents: g.unpricedActualCostInUsdCents,
  }));
}
