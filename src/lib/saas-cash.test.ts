import { describe, expect, it } from "vitest";
import { computeSaasCash, isoWeekLabel, isoWeekStart, type OrgVerdict } from "./saas-cash.js";

const verdicts = new Map<string, OrgVerdict>([
  ["saas-a", { orgName: "A", ownOrg: false, ownOrgReason: null }],
  ["saas-b", { orgName: "B", ownOrg: false, ownOrgReason: null }],
  ["agency", { orgName: "Agency Co", ownOrg: false, ownOrgReason: null }],
  ["ours", { orgName: "Distribute", ownOrg: true, ownOrgReason: "platform_org" }],
]);
const agency = new Set(["agency", "ours"]);

// org, day, gross, net, [agency gross outside the product, agency net outside the product]
type Row = [string | null, string, string, string, string?, string?];

function body(rows: Row[], totalGross: string, totalNet: string, now = "2026-11-21T10:00:00Z", agencyTotals: [string, string] = ["0", "0"]) {
  return computeSaasCash({
    cash: {
      asOf: now,
      totalGrossCents: totalGross,
      totalNetCents: totalNet,
      totalAgencyGrossCents: agencyTotals[0],
      totalAgencyNetCents: agencyTotals[1],
      rows: rows.map(([orgId, day, grossCents, netCents, agencyGrossCents = "0", agencyNetCents = "0"]) => ({
        orgId,
        day,
        grossCents,
        netCents,
        agencyGrossCents,
        agencyNetCents,
      })),
    },
    agencyOrgIds: agency,
    verdicts,
    now: new Date(now),
  });
}

describe("ISO weeks", () => {
  it("starts on Monday and labels by the Thursday's year", () => {
    expect(isoWeekStart("2026-11-21")).toBe("2026-11-16");
    expect(isoWeekStart("2026-11-16")).toBe("2026-11-16");
    expect(isoWeekLabel("2026-11-21")).toBe("2026-W47");
    expect(isoWeekLabel("2027-01-01")).toBe("2026-W53");
    expect(isoWeekLabel("2026-12-29")).toBe("2026-W53");
    expect(isoWeekLabel("2025-12-29")).toBe("2026-W01");
  });
});

describe("computeSaasCash", () => {
  const rows: Row[] = [
    ["saas-a", "2026-11-02", "10000.0000000000", "10000"],
    ["agency", "2026-11-03", "50000", "50000"],
    ["ours", "2026-11-04", "100", "100"],
    [null, "2026-11-05", "7", "7"],
    ["saas-b", "2026-11-17", "2500", "2500"],
    ["saas-a", "2026-11-18", "0", "-1000"], // a refund that HAPPENED on the 18th, no payment that day
  ];
  const b = body(rows, "62607", "61607");

  it("serves gross (headline), net and gross with agency per ISO week", () => {
    expect(b.firstPaymentDay).toBe("2026-11-02");
    expect(b.weeks.map((w) => [w.isoWeek, w.saasGrossCents, w.saasNetCents, w.withAgencyGrossCents, w.isCurrent])).toEqual([
      ["2026-W45", 10000, 10000, 60000, false],
      ["2026-W46", 0, 0, 0, false],
      ["2026-W47", 2500, 1500, 2500, true],
    ]);
  });

  it("a refund lands on the day it happened and moves net only", () => {
    const d18 = b.days.find((d) => d.day === "2026-11-18")!;
    expect(d18.cash).toMatchObject({ saasGrossCents: 0, saasNetCents: -1000, withAgencyGrossCents: 0 });
    const d02 = b.days.find((d) => d.day === "2026-11-02")!;
    expect(d02.cash.saasNetCents).toBe(10000);
  });

  it("SaaS net <= SaaS gross on every week, every day and every cumulative point", () => {
    for (const w of b.weeks) expect(w.saasNetCents).toBeLessThanOrEqual(w.saasGrossCents);
    for (const d of b.days) {
      expect(d.cash.saasNetCents).toBeLessThanOrEqual(d.cash.saasGrossCents);
      expect(d.cumulative.saasNetCents).toBeLessThanOrEqual(d.cumulative.saasGrossCents);
    }
  });

  it("the last cumulative point equals Σ weekly bars and the since-inception totals, for all three series", () => {
    const last = b.days[b.days.length - 1];
    expect(last.day).toBe("2026-11-21");
    expect(last.isCurrent).toBe(true);
    expect(b.days.filter((d) => d.isCurrent)).toHaveLength(1);
    for (const k of ["saasGrossCents", "saasNetCents", "withAgencyGrossCents"] as const) {
      expect(last.cumulative[k]).toBe(b.weeks.reduce((s, w) => s + w[k], 0));
      expect(last.cumulative[k]).toBe(b.totals.sinceInception[k]);
    }
    expect(b.totals.sinceInception).toEqual({
      saasGrossCents: 12500,
      saasGrossUsd: 125,
      saasNetCents: 11500,
      saasNetUsd: 115,
      withAgencyGrossCents: 62500,
      withAgencyGrossUsd: 625,
    });
    expect(b.totals.thisWeek).toMatchObject({ saasGrossCents: 2500, saasNetCents: 1500, withAgencyGrossCents: 2500 });
  });

  it("SaaS gross + agency gross + own + unattributed = billing's fleet gross; same on net", () => {
    expect(b.reconciliation.gross).toEqual({
      saasCents: 12500,
      agencyCents: 50000,
      ownOrgsCents: 100,
      unattributedCents: 7,
      fleetCents: 62607,
      sidesTotalCents: 62607,
      differenceCents: 0,
    });
    expect(b.reconciliation.net).toMatchObject({ saasCents: 11500, fleetCents: 61607, differenceCents: 0 });
    // with-agency series = SaaS gross + agency gross, exactly
    expect(b.totals.sinceInception.withAgencyGrossCents).toBe(b.reconciliation.gross.saasCents + b.reconciliation.gross.agencyCents);
    expect(b.excludedOrgs.map((o) => [o.orgId, o.side, o.reason, o.grossCents, o.netCents])).toEqual([
      ["agency", "agency", "stated_monthly_amount", 50000, 50000],
      ["ours", "own_org", "platform_org", 100, 100],
    ]);
    expect(b.payingSaasOrgs).toBe(2);
  });

  it("an agency payment never moves the SaaS series, only the with-agency one", () => {
    const base = body([["saas-a", "2026-11-17", "1000", "1000"]], "1000", "1000");
    const withAgency = body(
      [["saas-a", "2026-11-17", "1000", "1000"], ["agency", "2026-11-17", "999999", "999999"]],
      "1000999",
      "1000999",
    );
    expect(withAgency.weeks.map((w) => [w.saasGrossCents, w.saasNetCents])).toEqual(base.weeks.map((w) => [w.saasGrossCents, w.saasNetCents]));
    expect(withAgency.totals.sinceInception.withAgencyGrossCents).toBe(1000999);
  });

  it("agency money received outside the product counts only in the with-agency series, on its own day", () => {
    const x = body(
      [
        ["saas-a", "2026-11-17", "1000", "1000"],
        [null, "2026-11-18", "0", "0", "200000", "200000"], // a payment request staff sent by hand, no org
        ["agency", "2026-11-19", "500", "500", "1250", "1250"],
      ],
      "1500",
      "1500",
      "2026-11-21T10:00:00Z",
      ["201250", "201250"],
    );
    expect(x.totals.sinceInception).toMatchObject({ saasGrossCents: 1000, saasNetCents: 1000, withAgencyGrossCents: 1000 + 500 + 201250 });
    expect(x.days.find((d) => d.day === "2026-11-18")!.cash).toMatchObject({ saasGrossCents: 0, withAgencyGrossCents: 200000 });
    expect(x.reconciliation.gross).toMatchObject({ saasCents: 1000, agencyCents: 500, unattributedCents: 0, fleetCents: 1500, differenceCents: 0 });
    expect(x.reconciliation.agencyOutsideProduct).toEqual({
      grossCents: 201250,
      netCents: 201250,
      billingGrossCents: 201250,
      billingNetCents: 201250,
      differenceCents: 0,
    });
    const last = x.days[x.days.length - 1];
    expect(last.cumulative.withAgencyGrossCents).toBe(x.weeks.reduce((s, w) => s + w.withAgencyGrossCents, 0));
    expect(() => body([[null, "2026-11-18", "0", "0", "10", "11"]], "0", "0", "2026-11-21T10:00:00Z", ["10", "11"])).toThrow(/agency net/);
  });

  it("an org without a verdict counts as SaaS and is named", () => {
    const x = body([["new-org", "2026-11-20", "500", "500"]], "500", "500");
    expect(x.totals.sinceInception.saasGrossCents).toBe(500);
    expect(x.saasOrgsWithoutVerdict).toEqual(["new-org"]);
  });

  it("rounds each (org, day) to whole cents once and states the residue", () => {
    const x = body([["saas-a", "2026-11-20", "100.4", "100.4"], ["saas-b", "2026-11-20", "100.4", "100.4"]], "200.8", "200.8");
    expect(x.totals.sinceInception.saasGrossCents).toBe(200);
    expect(x.reconciliation.gross.differenceCents).toBe(1);
  });

  it("nobody ever paid = empty series, never a made-up first day", () => {
    const x = body([], "0", "0");
    expect(x.firstPaymentDay).toBeNull();
    expect(x.weeks).toEqual([]);
    expect(x.days).toEqual([]);
  });

  it("fails loud on a day after today, a non-decimal amount, net above gross or negative gross", () => {
    expect(() => body([["saas-a", "2026-11-22", "1", "1"]], "1", "1")).toThrow(/after today/);
    expect(() => body([["saas-a", "2026-11-20", "abc", "1"]], "1", "1")).toThrow(/not a decimal/);
    expect(() => body([["saas-a", "2026-11-20", "100", "101"]], "100", "101")).toThrow(/above gross/);
    expect(() => body([["saas-a", "2026-11-20", "-5", "-5"]], "-5", "-5")).toThrow(/negative gross/);
  });
});
