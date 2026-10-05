import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeSourcingInvestment,
  fetchServeRunCosts,
  fetchListBuildCosts,
  type ServeRunCost,
} from "./sourcing-investment.js";
import type { ServedPersonRow } from "./leads-client.js";

const serve = (runId: string, audienceId: string | null, billed: string, vendor = billed, unpriced = "0", campaignId = "c1"): ServeRunCost => ({
  runId,
  audienceId,
  campaignId,
  billedCents: billed,
  netCents: billed,
  vendorCents: vendor,
  unpricedBilledCents: unpriced,
});

const row = (runId: string, leadId: string, extra: Partial<ServedPersonRow> = {}): ServedPersonRow => ({
  runId,
  leadId,
  apolloPersonId: `ap-${leadId}`,
  campaignId: "c1",
  audienceId: "A",
  email: `${leadId}@x.com`,
  firstName: "F",
  lastName: "L",
  companyName: "Acme",
  companyDomain: "acme.com",
  ...extra,
});

describe("computeSourcingInvestment", () => {
  it("audiences + withoutAudience reconcile EXACTLY with the total, people + notOnAPerson with the serves", () => {
    const r = computeSourcingInvestment({
      serves: [
        serve("r1", "A", "10.1000000000", "4.0000000000"),
        serve("r2", "A", "5.0000000000", "2.0000000000"),
        serve("r3", "B", "3.0000000000", "1.0000000000"),
        serve("r4", "A", "0.7000000000", "0.3000000000"), // screened everyone out: no person
        serve("r5", null, "1.0000000000", "0.5000000000"),
      ],
      listBuild: [
        { audienceId: "A", billedCents: "129.0000000000", netCents: "129.0000000000", vendorCents: "100.0000000000", unpricedBilledCents: "0" },
        { audienceId: null, billedCents: "2.0000000000", netCents: "2.0000000000", vendorCents: "1.0000000000", unpricedBilledCents: "0" },
      ],
      servedRows: [
        row("r1", "p1"),
        row("r2", "p2", { companyDomain: "beta.io", companyName: "Beta" }),
        row("r3", "p1", { campaignId: "c2", audienceId: "B" }), // same person, second campaign
        row("r5", "p3", { companyDomain: null }),
      ],
    });

    expect(r.total.billedUsd).toBeCloseTo(1.508, 10);
    const sumAud = r.audiences.reduce((s, a) => s + a.invested.billedUsd, 0) + r.withoutAudience.billedUsd;
    expect(sumAud).toBeCloseTo(r.total.billedUsd, 10);
    expect(r.withoutAudience.billedUsd).toBeCloseTo(0.03, 10);

    const sumPeople = r.people.reduce((s, p) => s + p.invested.billedUsd, 0);
    expect(sumPeople + r.notOnAPerson.billedUsd).toBeCloseTo(r.serves.billedUsd, 10);
    expect(r.notOnAPerson.billedUsd).toBeCloseTo(0.007, 10);
    expect(r.servesWithoutPerson).toBe(1);

    const p1 = r.people.find((p) => p.leadId === "p1")!;
    expect(p1.serveCount).toBe(2);
    expect(p1.invested.billedUsd).toBeCloseTo(0.131, 10);
    expect(p1.audienceIds).toEqual(["A", "B"]);

    const a = r.audiences.find((x) => x.audienceId === "A")!;
    expect(a.invested.billedUsd).toBeCloseTo(1.448, 10);
    expect(a.listBuild.billedUsd).toBeCloseTo(1.29, 10);
    expect(a.notOnAPerson.billedUsd).toBeCloseTo(0.007, 10);
    expect(a.serveCount).toBe(3);
    expect(a.personCount).toBe(2);
    expect(a.companyCount).toBe(2);

    // company = Σ its people; a person without a domain is in no company
    const acme = r.companies.find((c) => c.companyDomain === "acme.com")!;
    expect(acme.personCount).toBe(1);
    expect(acme.invested.billedUsd).toBeCloseTo(0.131, 10);
    expect(r.peopleWithoutCompanyDomain.personCount).toBe(1);
    const sumCompanies = r.companies.reduce((s, c) => s + c.invested.billedUsd, 0);
    expect(sumCompanies + r.peopleWithoutCompanyDomain.invested.billedUsd).toBeCloseTo(sumPeople, 10);

    expect(r.audiences[0]!.audienceId).toBe("A"); // billed desc
  });

  it("net is the producer's frozen net, summed beside billed (never billed × a discount here)", () => {
    const r = computeSourcingInvestment({
      serves: [{ ...serve("r1", "A", "10"), netCents: "8" }, { ...serve("r2", "A", "5"), netCents: "4" }],
      listBuild: [{ audienceId: "A", billedCents: "100", netCents: "80", vendorCents: "50", unpricedBilledCents: "0" }],
      servedRows: [row("r1", "p1"), row("r2", "p2")],
    });
    expect(r.total.billedUsd).toBeCloseTo(1.15, 10);
    expect(r.total.netUsd).toBeCloseTo(0.92, 10);
    expect(r.audiences[0]!.invested.netUsd).toBeCloseTo(0.92, 10);
    expect(r.people.find((p) => p.leadId === "p1")!.invested.netUsd).toBeCloseTo(0.08, 10);
  });

  it("vendor is NULL (never the billed figure) when part of the figure has no known vendor cost", () => {
    const r = computeSourcingInvestment({
      serves: [serve("r1", "A", "10", "4", "0"), serve("r2", "A", "5", "0", "5")],
      listBuild: [],
      servedRows: [row("r1", "p1"), row("r2", "p2")],
    });
    expect(r.total.vendorUsd).toBeNull();
    expect(r.total.unpricedBilledUsd).toBeCloseTo(0.05, 10);
    expect(r.people.find((p) => p.leadId === "p1")!.invested.vendorUsd).toBeCloseTo(0.04, 10);
    expect(r.people.find((p) => p.leadId === "p2")!.invested.vendorUsd).toBeNull();
  });

  it("a lead row whose run is not one of the brand's serves carries no cost; a run on two rows is counted once", () => {
    const r = computeSourcingInvestment({
      serves: [serve("r1", "A", "10")],
      listBuild: [],
      servedRows: [row("rX", "p9"), row("r1", "p1"), row("r1", "p2")],
    });
    expect(r.people.map((p) => p.leadId)).toEqual(["p1"]);
    expect(r.people[0]!.invested.billedUsd).toBeCloseTo(0.1, 10);
  });
});

describe("runs-service reads", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const run = (id: string) => ({
    id,
    audienceId: "A",
    campaignId: "c1",
    actualCostInUsdCents: "1.0000000000",
    vendorActualCostInUsdCents: "0.5000000000",
    unpricedActualCostInUsdCents: "0.0000000000",
  });

  it("walks every page of the brand's lead-serve runs on the vendor run list, deduping a shifted repeat", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => run(`r${i}`));
    const page2 = [run("r499"), run("r500")];
    const net = (rows: Array<{ id: string }>) => json({ runs: rows.map((r) => ({ id: r.id, netActualCostInUsdCents: "0.8000000000" })) });
    fetchMock
      .mockResolvedValueOnce(json({ runs: page1 }))
      .mockResolvedValueOnce(json({ runs: page2 }))
      .mockResolvedValueOnce(net(page1))
      .mockResolvedValueOnce(net([...page2, { id: "r-new" }]));
    const out = await fetchServeRunCosts("b1", "org-1");
    expect(out).toHaveLength(501);
    expect(out[0]!.netCents).toBe("0.8000000000");
    const netUrl = new URL(fetchMock.mock.calls[2]![0] as string);
    expect(netUrl.pathname).toBe("/v1/runs");
    expect(netUrl.searchParams.get("include")).toBe("subtreeCost");
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/internal/runs/vendor");
    expect(url.searchParams.get("serviceName")).toBe("lead-service");
    expect(url.searchParams.get("taskName")).toBe("lead-serve");
    expect(url.searchParams.get("orgId")).toBe("org-1");
    expect(url.searchParams.get("brandId")).toBe("b1");
    expect(new URL(fetchMock.mock.calls[1]![0] as string).searchParams.get("offset")).toBe("500");
  });

  it("a serve run with no stated net subtree cost fails loud, never a guessed net", async () => {
    fetchMock.mockResolvedValueOnce(json({ runs: [run("r1")] })).mockResolvedValueOnce(json({ runs: [{ id: "r1" }] }));
    await expect(fetchServeRunCosts("b1", "org-1")).rejects.toThrow(/no net subtree cost/);
  });

  it("fails loud on a runs-service error, never an empty list", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchServeRunCosts("b1", "org-1")).rejects.toThrow(/internal\/runs\/vendor failed/);
  });

  it("reads list-build spend per audience from the vendor grouped read", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ groups: [{ dimensions: { audienceId: "A" }, actualCostInUsdCents: "129", vendorActualCostInUsdCents: "100", unpricedActualCostInUsdCents: "0" }] }),
      )
      .mockResolvedValueOnce(json({ groups: [{ dimensions: { audienceId: "A" }, netActualCostInUsdCents: "116" }] }));
    const out = await fetchListBuildCosts("b1", "org-1");
    expect(out).toEqual([{ audienceId: "A", billedCents: "129", netCents: "116", vendorCents: "100", unpricedBilledCents: "0" }]);
    expect(new URL(fetchMock.mock.calls[1]![0] as string).pathname).toBe("/v1/stats/costs");
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("taskName")).toBe("audience-companies");
    expect(url.searchParams.get("groupBy")).toBe("audienceId");
  });
});
