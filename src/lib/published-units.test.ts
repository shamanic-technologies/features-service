import { describe, expect, it } from "vitest";
import { addInputCosts, engagementBreakdownOf, engagementsOfBreakdown, expectedReturnOf, MEASURED_RETURN_MIN_UNITS, bulkVisitCredits, runAggregateOf, creditOfRow, creditsByOccurrence, engagementsOf, publishedUnitsOf, type LedgerOccurrence, type UnitSource } from "./published-units.js";

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
    expect(body.totals.all).toMatchObject({ rows: 3, units: 3, views: 150, viewsReportedRows: 2, engagements: 4, visits: 5, signups: 2, spentUsd: 2.01 });
    expect(body.totals.ours).toMatchObject({ rows: 2, signups: 1, spentUsd: 2 });
    expect(body.costPerSignupUsd).toBe(2);
    expect(body.learning).toBe(false);
    expect(body.daily).toMatchObject([
      { date: "2026-11-01", units: 2, oursUnits: 2, views: 100, visits: 3, signups: 1, spentUsd: 2 },
      { date: "2026-11-02", units: 1, oursUnits: 0, views: 50, visits: 2, signups: 1, spentUsd: 0.01 },
    ]);
    const none = publishedUnitsOf("x_post_published", rows, () => ({ spentUsd: 1, visits: 0, signups: 0 }));
    expect(none.costPerSignupUsd).toBeNull();
    expect(none.learning).toBe(true);
  });

  it("full absorption: what the Unit's run consumed is spread over that run's Units of the key", () => {
    const u = [
      occ({ id: "e1", runId: "rel", direction: "produced", outcomeKey: "newsletter_email_sent", cost: { grossCents: "0", netCents: "0" } }),
      occ({ id: "e2", runId: "rel", direction: "produced", outcomeKey: "newsletter_email_sent", cost: { grossCents: "0", netCents: "0" } }),
    ];
    const sent = (id: string, cents: string) =>
      occ({ id, runId: "rel", direction: "consumed", outcomeKey: "message_sent", consumption: { sourceOccurrenceId: null, consumingOutcomes: [{ outcomeKey: "newsletter_email_sent", standardCost: { grossCents: cents, netCents: cents } }] } });
    const other = occ({ id: "o", runId: "rel", direction: "consumed", outcomeKey: "x", consumption: { sourceOccurrenceId: null, consumingOutcomes: [{ outcomeKey: "something_else", standardCost: { grossCents: "99", netCents: "99" } }] } });
    const credits = creditsByOccurrence(u, [], [], [], "net");
    addInputCosts(credits, u, [sent("m1", "1.5"), sent("m2", "1.5"), other], "net");
    expect(credits.get("e1")!.spentUsd).toBeCloseTo(0.015, 10);
    expect(credits.get("e2")!.spentUsd).toBeCloseTo(0.015, 10);
  });

  it("a bulk run (newsletter release): its total cost, visits through any of its Units, signups from those visits", () => {
    const produced = [1, 2, 3].map((i) => occ({ id: `n${i}`, runId: "rel", direction: "produced", outcomeKey: "newsletter_email_sent", cost: { grossCents: "0", netCents: "0" } }));
    const consumed = [1, 2, 3].map((i) =>
      occ({ id: `m${i}`, runId: "rel", direction: "consumed", outcomeKey: "message_sent", consumption: { sourceOccurrenceId: null, consumingOutcomes: [{ outcomeKey: "newsletter_email_sent", standardCost: { grossCents: "2", netCents: "1.5" } }] } }),
    );
    expect(runAggregateOf("newsletter_email_sent", produced, consumed)).toEqual({ units: 3, netUsd: 0.045, grossUsd: 0.06 });
    const click = occ({ id: "c", runId: "vr", direction: "consumed", outcomeKey: "newsletter_email_sent", consumption: { sourceOccurrenceId: "n2", sourceRunId: "rel", consumingOutcomes: [{ outcomeKey: "website_visit" }] } });
    const elsewhere = occ({ id: "c2", runId: "vr2", direction: "consumed", outcomeKey: "newsletter_email_sent", consumption: { sourceOccurrenceId: "z", sourceRunId: "other", consumingOutcomes: [{ outcomeKey: "website_visit" }] } });
    const visit = occ({ id: "w", runId: "vr", direction: "produced", outcomeKey: "website_visit" });
    const signup = consumed[0] && occ({ id: "s", runId: "sr", direction: "consumed", outcomeKey: "website_visit", consumption: { sourceOccurrenceId: "w", consumingOutcomes: [{ outcomeKey: "signup" }] } });
    expect(bulkVisitCredits(new Set(["rel"]), [click, elsewhere], [visit], [signup!]).get("rel")).toEqual({ visits: 1, signups: 1 });
  });

  it("engagements sum the counts the platform reports; none reported = null", () => {
    expect(engagementsOf({ likes: 2, replies: null, reposts: 1 }, ["likes", "replies", "reposts", "quotes"])).toBe(3);
    expect(engagementsOf({ likes: null }, ["likes", "replies"])).toBeNull();
  });

  describe("SOCIAL-OUTCOMES-1107: breakdown, reposts, visit attribution, value and returns", () => {
    const post = (id: string, over: Partial<UnitSource> = {}): UnitSource => ({
      id,
      publishedAt: "2026-11-03T10:00:00Z",
      account: "@us",
      performedBy: "ours",
      text: id,
      url: null,
      units: 1,
      views: 100,
      engagements: null,
      ledger: { runId: `r-${id}`, outcomeKey: "x_post_published", subjectId: null },
      ...over,
    });
    const credit = () => ({ spentUsd: 0.5, visits: 1, signups: 0 });

    it("the breakdown sums to engagements on every row, total and day; unreported kinds stay null", () => {
      const b = engagementBreakdownOf({ views: 9, likes: 2, replies: 3, reposts: 1, quotes: 0, bookmarks: null });
      expect(b).toEqual({ likes: 2, replies: 3, reposts: 1, quotes: 0, shares: null, bookmarks: null, clicks: null });
      expect(engagementsOfBreakdown(b)).toBe(6);
      const body = publishedUnitsOf("x_post_published", [post("a", { metrics: { likes: 2, replies: 3, reposts: 1 } }), post("b", { metrics: { likes: 4, bookmarks: 1 } })], credit);
      for (const r of body.rows) expect(engagementsOfBreakdown(r.engagementBreakdown)).toBe(r.engagements);
      expect(body.totals.all.engagements).toBe(11);
      expect(body.totals.all.engagementBreakdown).toEqual({ likes: 6, replies: 3, reposts: 1, quotes: null, shares: null, bookmarks: 1, clicks: null });
      expect(body.daily[0]!.engagements).toBe(11);
    });

    it("a repost of someone else's post (kind repost) is no Unit of ours: out of every row and total, its engagements stated apart", () => {
      const rt = post("rt", { text: "RT @tparsi: ...", views: 30, metrics: { likes: 11000, reposts: 701 }, kind: "repost" });
      const body = publishedUnitsOf("x_post_published", [post("own", { metrics: { likes: 3 }, kind: "post" }), rt, post("q", { kind: "quote", metrics: { likes: 1 } })], credit);
      expect(body.rows.map((r) => r.id).sort()).toEqual(["own", "q"]);
      expect(body.totals.all.engagements).toBe(4);
      expect(body.repostsExcluded).toEqual({ rows: 1, engagements: 11701 });
    });

    it("more engagements than views is flagged, never silently served as consistent", () => {
      const body = publishedUnitsOf("threads_post_published", [post("t", { views: 0, metrics: { replies: 3 } })], credit);
      expect(body.rows[0]).toMatchObject({ engagements: 3, metricsWarning: "engagements_exceed_views" });
      expect(body.totals.all.rowsEngagementsAboveViews).toBe(1);
    });

    it("an outcome with no click signal on the ledger serves visits and signups null with a reason, never 0", () => {
      const body = publishedUnitsOf("x_post_published", [post("a")], credit, { visitsMeasured: false });
      expect(body.rows[0]).toMatchObject({ visits: null, signups: null, visitsUnavailableReason: "no_visit_attribution_on_outcome", spentUsd: 0.5 });
      expect(body).toMatchObject({ visitsMeasured: false, costPerSignupUsd: null, costPerSignupUnavailableReason: "no_visit_attribution_on_outcome" });
    });

    it("value = units x value per Unit; measured return on ours = value / spend, Learning under the bar; expected = value / expected cost", () => {
      const unitValueOf = () => ({ valuePerUnitUsd: 2, step: "post_published", offerId: "o1", lifetimeRevenueSource: "offer_stated" as const, unavailableReason: null });
      const expected = expectedReturnOf(2, { costPerUnitUsd: 0.8, costSource: "workflow", basis: "measured", pipeId: "p" }, null);
      expect(expected).toMatchObject({ roiMultiple: 2.5, valuePerUnitUsd: 2, costPerUnitUsd: 0.8 });
      const few = publishedUnitsOf("x_post_published", [post("a"), post("b", { performedBy: "client_team" })], credit, { unitValueOf, expected });
      expect(few.rows[0]).toMatchObject({ valueUsd: 2, measuredReturn: { roiMultiple: 4, valueUsd: 2, spentUsd: 0.5, learning: true } });
      expect(few.totals.all.valueUsd).toBe(4);
      expect(few.totals.ours.valueUsd).toBe(2);
      expect(few.measuredReturn).toMatchObject({ roiMultiple: 4, learning: true });
      expect(few.expectedReturn.roiMultiple).toBe(2.5);
      expect(few.daily[0]).toMatchObject({ valueUsd: 4, oursValueUsd: 2, oursSpentUsd: 0.5, measuredReturn: { roiMultiple: 4 } });
      const many = Array.from({ length: MEASURED_RETURN_MIN_UNITS }, (_, i) => post(`m${i}`));
      expect(publishedUnitsOf("x_post_published", many, credit, { unitValueOf, expected }).measuredReturn).toMatchObject({ roiMultiple: 4, learning: false, valueUsd: 20, spentUsd: 5 });
      const unvalued = publishedUnitsOf("x_post_published", [post("a")], credit);
      expect(unvalued.measuredReturn).toMatchObject({ roiMultiple: null, unavailableReason: "unit_has_no_value" });
      expect(unvalued.expectedReturn).toMatchObject({ roiMultiple: null, unavailableReason: "not_priced" });
      // No catalogue pipe prices the outcome: expected cost = what one cost to date (ours), never blank.
      const noPipe = publishedUnitsOf("x_post_published", [post("a"), post("b")], credit, { unitValueOf, expected: expectedReturnOf(2, null, null) });
      expect(noPipe.expectedReturn).toMatchObject({ roiMultiple: 4, costPerUnitUsd: 0.5, costSource: "own_spend", basis: "measured", pipeId: null, unavailableReason: null });
      expect(publishedUnitsOf("x_post_published", [post("a")], () => ({ spentUsd: 0, visits: 0, signups: 0 }), { unitValueOf }).measuredReturn.unavailableReason).toBe("nothing_spent_yet");
    });
  });
});
