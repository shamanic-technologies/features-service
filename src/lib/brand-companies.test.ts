import { describe, expect, it } from "vitest";
import { buildCompanyIndex, oneCompany, pageCompanies, parseCompanyPageQuery, type StoredCompany, type StoredLifecycle } from "./brand-companies.js";

const row = (key: string, o: Partial<StoredCompany>): StoredCompany => ({
  organizationKey: key,
  orgId: null,
  orgName: null,
  orgLogoUrl: "https://logo",
  orgDomain: null,
  topPerson: { firstName: "A", lastName: "B", photoUrl: null },
  peopleCount: 1,
  tags: ["delivered"],
  expectedRevenueUsd: 0,
  mostAdvancedDate: null,
  ...o,
});

// Stored order is what a tie keeps.
const ORGS: StoredCompany[] = [
  row("org:1", { orgId: "1", orgName: "Acme Corp", orgDomain: "acme.com", expectedRevenueUsd: 10, mostAdvancedDate: "2026-11-01T00:00:00Z" }),
  row("org:2", { orgId: "2", orgName: "Beta", orgDomain: "beta.io", expectedRevenueUsd: 50, mostAdvancedDate: "2026-10-01T00:00:00Z" }),
  row("lead:9", { expectedRevenueUsd: 10 }),
  row("org:3", { orgId: "3", orgName: "Zeta Labs", orgDomain: null, expectedRevenueUsd: 0, mostAdvancedDate: "2026-11-05T00:00:00Z" }),
];
const RUNG = (key: string, rank: number) => ({ key, rank, label: key.toUpperCase() });
const LIFECYCLE: StoredLifecycle = {
  rungs: [{ ...RUNG("contacted", 1), organizationCount: 2 }, { ...RUNG("engaged", 2), organizationCount: 1 }],
  organizations: [
    { organizationKey: "org:2", lifecycle: RUNG("engaged", 2) },
    { organizationKey: "org:1", lifecycle: RUNG("contacted", 1) },
    { organizationKey: "org:3", lifecycle: RUNG("contacted", 1) },
  ],
};
const Q = { sort: "value" as const, q: null, rung: null, offset: 0, limit: 60 };

describe("brand companies index (MON-PAGE-SPEED-2-1112)", () => {
  const index = buildCompanyIndex(ORGS, LIFECYCLE);

  it("serves the stored rows slim (no logo), each with its served rung and its URL key", () => {
    const { total, companies } = pageCompanies(index, Q);
    expect(total).toBe(4);
    expect(companies.map((c) => c.organizationKey)).toEqual(["org:2", "org:1", "lead:9", "org:3"]);
    expect(companies[0]).toEqual({
      organizationKey: "org:2",
      companyKey: "beta.io",
      orgId: "2",
      orgName: "Beta",
      orgDomain: "beta.io",
      topPerson: { firstName: "A", lastName: "B", photoUrl: null },
      peopleCount: 1,
      tags: ["delivered"],
      expectedRevenueUsd: 50,
      mostAdvancedDate: "2026-10-01T00:00:00Z",
      lifecycle: RUNG("engaged", 2),
    });
    expect(companies[2].lifecycle).toBeNull();
    expect(companies[2].companyKey).toBeNull();
    expect(companies[3].companyKey).toBe("3");
    expect(index.rungs).toEqual(LIFECYCLE.rungs);
  });

  it("sorts by last touch and by name, ties in stored order", () => {
    expect(pageCompanies(index, { ...Q, sort: "touch" }).companies.map((c) => c.organizationKey)).toEqual(["org:3", "org:1", "org:2", "lead:9"]);
    expect(pageCompanies(index, { ...Q, sort: "name" }).companies.map((c) => c.organizationKey)).toEqual(["lead:9", "org:1", "org:2", "org:3"]);
  });

  it("filters by every search word (name or domain) and by rung, total before paging", () => {
    expect(pageCompanies(index, { ...Q, q: "ACME com" }).companies.map((c) => c.organizationKey)).toEqual(["org:1"]);
    expect(pageCompanies(index, { ...Q, q: "acme beta" }).total).toBe(0);
    const contacted = pageCompanies(index, { ...Q, rung: "contacted", limit: 1 });
    expect(contacted.total).toBe(2);
    expect(contacted.companies.map((c) => c.organizationKey)).toEqual(["org:1"]);
    expect(pageCompanies(index, { ...Q, rung: "contacted", offset: 1 }).companies.map((c) => c.organizationKey)).toEqual(["org:3"]);
  });

  it("one company: its place in the value order and its neighbours", () => {
    expect(oneCompany(index, "acme.com")).toEqual({
      company: expect.objectContaining({ organizationKey: "org:1" }),
      position: 2,
      previousKey: "beta.io",
      nextKey: null,
    });
    expect(oneCompany(index, "beta.io")?.previousKey).toBeNull();
    expect(oneCompany(index, "nope.com")).toBeNull();
  });

  it("a brand with no lifecycle: every row on no rung, no rungs", () => {
    const bare = buildCompanyIndex(ORGS, null);
    expect(bare.rungs).toEqual([]);
    expect(pageCompanies(bare, Q).companies.every((c) => c.lifecycle === null)).toBe(true);
  });
});

describe("parseCompanyPageQuery", () => {
  it("defaults and refusals", () => {
    expect(parseCompanyPageQuery({})).toEqual(Q);
    expect(parseCompanyPageQuery({ q: "  ", sort: "name", offset: "60", limit: "6", rung: "engaged" })).toEqual({ ...Q, sort: "name", offset: 60, limit: 6, rung: "engaged" });
    expect(parseCompanyPageQuery({ sort: "size" })).toMatchObject({ reason: "sort_unrecognised" });
    expect(parseCompanyPageQuery({ limit: "0" })).toMatchObject({ reason: "limit_invalid" });
    expect(parseCompanyPageQuery({ limit: "5001" })).toMatchObject({ reason: "limit_invalid" });
    expect(parseCompanyPageQuery({ offset: "-1" })).toMatchObject({ reason: "offset_invalid" });
    expect(parseCompanyPageQuery({ rung: "" })).toMatchObject({ reason: "rung_invalid" });
  });
});
