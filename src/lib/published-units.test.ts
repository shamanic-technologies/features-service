import { describe, expect, it } from "vitest";
import { creditOfRow, creditsByOccurrence, engagementsOf, publishedUnitsOf, type LedgerOccurrence, type UnitSource } from "./published-units.js";

const occ = (o: Partial<LedgerOccurrence> & Pick<LedgerOccurrence, "id" | "runId" | "direction" | "outcomeKey">): LedgerOccurrence => ({
  subjectService: "meta-service",
  subjectId: o.id,
  cost: null,
  consumption: null,
  ...o,
});
const consumed = (id: string, runId: string, key: string, source: string, into: string) =>
  occ({ id, runId, direction: "consumed", outcomeKey: key, consumption: { sourceOccurrenceId: source, consumingOutcomes: [{ outcomeKey: into }] } });

describe("published units (OUTCOME-FINEST-1106): each creative with what the ledger credits it", () => {
  const units = [
    occ({ id: "u1", runId: "r1", direction: "produced", outcomeKey: "threads_post_published", subjectId: "p1", cost: { grossCents: "40", netCents: "20" } }),
    occ({ id: "u2", runId: "r2", direction: "produced", outcomeKey: "threads_post_published", subjectId: "p2", cost: { grossCents: "10", netCents: "10" } }),
  ];
  // Two visits through p1's link, one of them signs up; p1's view (post_viewed) is no visit.
  const unitConsumptions = [
    consumed("c1", "v1", "threads_post_published", "u1", "website_visit"),
    consumed("c2", "v2", "threads_post_published", "u1", "website_visit"),
    consumed("c3", "pv", "threads_post_published", "u1", "post_viewed"),
  ];
  const visits = [
    occ({ id: "w1", runId: "v1", direction: "produced", outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "l1" }),
    occ({ id: "w2", runId: "v2", direction: "produced", outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "l2" }),
    occ({ id: "w3", runId: "pv", direction: "produced", outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "l3" }),
  ];
  const visitConsumptions = [consumed("s1", "sg", "website_visit", "w1", "signup"), consumed("s2", "sg2", "website_visit", "w1", "signup")];

  it("credits visits only through a consumption of the Unit into a website visit, signups once per visit, cost on the asked basis", () => {
    const net = creditsByOccurrence(units, unitConsumptions, visits, visitConsumptions, "net");
    expect(net.get("u1")).toEqual({ spentUsd: 0.2, visits: 2, signups: 1 });
    expect(net.get("u2")).toEqual({ spentUsd: 0.1, visits: 0, signups: 0 });
    expect(creditsByOccurrence(units, unitConsumptions, visits, visitConsumptions, "gross").get("u1")!.spentUsd).toBe(0.4);
  });

  it("a row sums the Units on its run with its key; its own subject wins on a run holding several", () => {
    const credits = creditsByOccurrence(units, unitConsumptions, visits, visitConsumptions, "net");
    const both = [units[0]!, { ...units[1]!, runId: "r1" }];
    const byRun = new Map([["r1", both]]);
    const src = (subjectId: string | null): UnitSource => ({ id: "x", publishedAt: "2026-11-01T00:00:00Z", account: null, performedBy: "ours", text: null, url: null, units: 1, views: null, engagements: null, ledger: { runId: "r1", outcomeKey: "threads_post_published", subjectId } });
    expect(creditOfRow(src("p2"), byRun, credits)).toEqual({ spentUsd: 0.1, visits: 0, signups: 0 });
    expect(creditOfRow(src(null), byRun, credits)).toEqual({ spentUsd: 0.3, visits: 2, signups: 1 });
    expect(creditOfRow({ ...src(null), ledger: null }, byRun, credits)).toBeNull();
    expect(creditOfRow({ ...src(null), ledger: { runId: "r9", outcomeKey: "threads_post_published", subjectId: null } }, byRun, credits)).toBeNull();
  });

  it("totals all and ours, $ per signup on ours only (Learning while none), day series on the publish day, newest first", () => {
    const rows: UnitSource[] = [
      { id: "a", publishedAt: "2026-11-01T09:00:00Z", account: "@us", performedBy: "ours", text: "ours", url: "u", units: 1, views: 100, engagements: 4, ledger: { runId: "r1", outcomeKey: "k", subjectId: null } },
      { id: "b", publishedAt: "2026-11-02T09:00:00Z", account: "@us", performedBy: "client_team", text: "hand", url: "u", units: 1, views: 50, engagements: null, ledger: { runId: "r2", outcomeKey: "k", subjectId: null } },
      { id: "c", publishedAt: "2026-11-01T18:00:00Z", account: "@us", performedBy: "ours", text: "new", url: null, units: 1, views: null, engagements: null, ledger: null },
    ];
    const credit = { a: { spentUsd: 2, visits: 3, signups: 1 }, b: { spentUsd: 0.01, visits: 2, signups: 1 } } as Record<string, { spentUsd: number; visits: number; signups: number }>;
    const body = publishedUnitsOf("threads_post_published", rows, (s) => credit[s.id] ?? null);
    expect(body.rows.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(body.rows.find((r) => r.id === "c")).toMatchObject({ spentUsd: null, visits: null, signups: null, ledgerUnavailableReason: "not_on_ledger_yet" });
    expect(body.totals.all).toEqual({ rows: 3, units: 3, views: 150, engagements: 4, visits: 5, signups: 2, spentUsd: 2.01 });
    expect(body.totals.ours).toMatchObject({ rows: 2, signups: 1, spentUsd: 2 });
    expect(body.costPerSignupUsd).toBe(2);
    expect(body.learning).toBe(false);
    expect(body.daily).toEqual([
      { date: "2026-11-01", units: 2, oursUnits: 2, views: 100, visits: 3, signups: 1, spentUsd: 2 },
      { date: "2026-11-02", units: 1, oursUnits: 0, views: 50, visits: 2, signups: 1, spentUsd: 0.01 },
    ]);
    const none = publishedUnitsOf("x_post_published", rows, () => ({ spentUsd: 1, visits: 0, signups: 0 }));
    expect(none.costPerSignupUsd).toBeNull();
    expect(none.learning).toBe(true);
  });

  it("engagements sum the counts the platform reports; none reported = null", () => {
    expect(engagementsOf({ likes: 2, replies: null, reposts: 1 }, ["likes", "replies", "reposts", "quotes"])).toBe(3);
    expect(engagementsOf({ likes: null }, ["likes", "replies"])).toBeNull();
  });
});
