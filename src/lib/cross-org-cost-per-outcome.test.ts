import { describe, it, expect } from "vitest";
import {
  normalizeObjective,
  buildLenientProjectionEconomics,
  objectiveCostPerOutcome,
  windowBaseOutcome,
  buildObjectiveAverages,
  buildLifetimeObjectiveAverages,
  buildCostPerOutcomeTrend,
  recentWindowCostPerOutcome,
  buildWorkflowCostPerOutcome,
  meanFleetEconomics,
  OBJECTIVES,
  type DayOutcome,
} from "./cross-org-cost-per-outcome.js";
import { projectedCostPerOutcome } from "./cost-engine.js";
import { projectOutcomeCosts, type SalesEconomics } from "./funnel-registry.js";

const FULL_ECON: SalesEconomics = {
  lifetimeRevenueUsd: 1000,
  replyToMeetingPct: 40,
  visitToMeetingPct: 5,
  meetingToClosePct: 30,
  visitToSignupPct: 20,
  signupToPaidClientPct: 10,
  visitToClosePct: 2,
  visitToPaidClientPct: 3,
  replyToPaidClientPct: 8,
  visitToFormSubmissionPct: 12,
  formSubmissionToPaidClientPct: 25,
};

describe("normalizeObjective", () => {
  it("accepts every fleet spelling and canonicalises to camelCase", () => {
    expect(normalizeObjective("websiteVisit")).toBe("websiteVisit");
    expect(normalizeObjective("website_visits")).toBe("websiteVisit");
    expect(normalizeObjective("website-visits")).toBe("websiteVisit");
    expect(normalizeObjective("positive_replies")).toBe("positiveReply");
    expect(normalizeObjective("form_submissions")).toBe("formSubmission");
    expect(normalizeObjective("meeting-booked")).toBe("meetingBooked");
    expect(normalizeObjective("meetingBooked")).toBe("meetingBooked");
    expect(normalizeObjective("self-serve")).toBe("signup");
    expect(normalizeObjective("signup")).toBe("signup");
    expect(normalizeObjective("purchase")).toBe("websitePurchase");
    expect(normalizeObjective("website_purchase")).toBe("websitePurchase");
    expect(normalizeObjective("sales")).toBe("sales");
  });
  it("returns null for unknown / missing", () => {
    expect(normalizeObjective(undefined)).toBeNull();
    expect(normalizeObjective("nonsense")).toBeNull();
  });
});

describe("objectiveCostPerOutcome", () => {
  const econ = buildLenientProjectionEconomics(FULL_ECON);
  const unit = { clickUsd: 1, replyUsd: 2 };

  it("websiteVisit = CPC (raw click unit cost), positiveReply = CPPR (raw reply unit cost)", () => {
    expect(objectiveCostPerOutcome("websiteVisit", unit, econ)).toBe(1);
    expect(objectiveCostPerOutcome("positiveReply", unit, econ)).toBe(2);
  });
  it("projected objectives match projectOutcomeCosts", () => {
    const p = projectOutcomeCosts(econ, unit);
    expect(objectiveCostPerOutcome("signup", unit, econ)).toBe(p.costPerSignupUsd);
    expect(objectiveCostPerOutcome("formSubmission", unit, econ)).toBe(p.costPerFormSubmissionUsd);
    expect(objectiveCostPerOutcome("meetingBooked", unit, econ)).toBe(p.costPerMeetingBookedUsd);
    expect(objectiveCostPerOutcome("websitePurchase", unit, econ)).toBe(p.costPerPurchaseUsd);
    expect(objectiveCostPerOutcome("sales", unit, econ)).toBe(p.costPerSaleUsd);
  });
  it("CPC/CPPR are null when the corresponding unit cost is null", () => {
    expect(objectiveCostPerOutcome("websiteVisit", { clickUsd: null, replyUsd: 2 }, econ)).toBeNull();
    expect(objectiveCostPerOutcome("positiveReply", { clickUsd: 1, replyUsd: null }, econ)).toBeNull();
  });
});

describe("windowBaseOutcome", () => {
  it("sizes by clicks for visit-driven, replies for positiveReply, both for close goals", () => {
    expect(windowBaseOutcome("websiteVisit", 10, 3)).toBe(10);
    expect(windowBaseOutcome("signup", 10, 3)).toBe(10);
    expect(windowBaseOutcome("formSubmission", 10, 3)).toBe(10);
    expect(windowBaseOutcome("positiveReply", 10, 3)).toBe(3);
    expect(windowBaseOutcome("meetingBooked", 10, 3)).toBe(13);
    expect(windowBaseOutcome("websitePurchase", 10, 3)).toBe(13);
    expect(windowBaseOutcome("sales", 10, 3)).toBe(13);
  });
});

describe("buildObjectiveAverages", () => {
  it("means each brand's best-workflow cost across brands; cheapest workflow wins per objective", () => {
    const unitCostList = [
      { clickUsd: 1, replyUsd: 2 }, // cheap → best
      { clickUsd: 5, replyUsd: 9 }, // expensive → never best
    ];
    const e2: SalesEconomics = { ...FULL_ECON, lifetimeRevenueUsd: 2000, replyToMeetingPct: 20, visitToMeetingPct: 10, meetingToClosePct: 50, visitToClosePct: 5 };
    const { objectives, brandCount } = buildObjectiveAverages(unitCostList, [FULL_ECON, e2]);

    expect(brandCount).toBe(2);
    // CPC / CPPR are brand-invariant (min unit cost) → the value itself.
    expect(objectives.websiteVisit).toBe(1);
    expect(objectives.positiveReply).toBe(2);
    // meetingBooked = mean of each brand's best (cheapest workflow) projection.
    const p1 = projectOutcomeCosts(buildLenientProjectionEconomics(FULL_ECON), { clickUsd: 1, replyUsd: 2 });
    const p2 = projectOutcomeCosts(buildLenientProjectionEconomics(e2), { clickUsd: 1, replyUsd: 2 });
    expect(objectives.meetingBooked!).toBeCloseTo((p1.costPerMeetingBookedUsd! + p2.costPerMeetingBookedUsd!) / 2, 6);
    expect(objectives.websitePurchase!).toBeCloseTo((p1.costPerPurchaseUsd! + p2.costPerPurchaseUsd!) / 2, 6);
    // every objective present in the map
    for (const g of OBJECTIVES) expect(g in objectives).toBe(true);
  });

  it("null + brandCount 0 when no brand supplied", () => {
    const { objectives, brandCount } = buildObjectiveAverages([{ clickUsd: 1, replyUsd: 2 }], []);
    expect(brandCount).toBe(0);
    for (const g of OBJECTIVES) expect(objectives[g]).toBeNull();
  });

  it("an objective with no backing rate across brands averages to null (never a false 0)", () => {
    // economics with NO form-submission rate → formSubmission unbacked → null; CPC still backed.
    const noForm: SalesEconomics = { ...FULL_ECON, visitToFormSubmissionPct: undefined, formSubmissionToPaidClientPct: undefined };
    const { objectives, brandCount } = buildObjectiveAverages([{ clickUsd: 1, replyUsd: 2 }], [noForm]);
    expect(brandCount).toBe(1);
    expect(objectives.websiteVisit).toBe(1);
    expect(objectives.formSubmission).toBeNull();
  });
});

describe("meanFleetEconomics", () => {
  it("returns null on empty; means each rate across brands", () => {
    expect(meanFleetEconomics([])).toBeNull();
    const a: SalesEconomics = { ...FULL_ECON, replyToMeetingPct: 40 };
    const b: SalesEconomics = { ...FULL_ECON, replyToMeetingPct: 20 };
    const m = meanFleetEconomics([a, b])!;
    expect(m.r2m).toBeCloseTo(0.3, 6); // (0.4 + 0.2)/2
  });
  it("an optional rate no brand carries stays undefined", () => {
    const noReplyPaid: SalesEconomics = { ...FULL_ECON, replyToPaidClientPct: undefined };
    const m = meanFleetEconomics([noReplyPaid])!;
    expect(m.r2pc).toBeUndefined();
  });
});

describe("buildLifetimeObjectiveAverages", () => {
  const fleetEcon = buildLenientProjectionEconomics(FULL_ECON);

  it("pools total spend ÷ total outcomes; websiteVisit = CPC, positiveReply = CPPR, projected via econ", () => {
    const objectives = buildLifetimeObjectiveAverages({
      totalSpentUsd: 400, totalClicks: 200, totalPositiveReplies: 100, fleetEcon,
    });
    // pooled CPC = 400/200 = $2, pooled CPPR = 400/100 = $4
    expect(objectives.websiteVisit).toBeCloseTo(2, 6);
    expect(objectives.positiveReply).toBeCloseTo(4, 6);
    const p = projectOutcomeCosts(fleetEcon, { clickUsd: 2, replyUsd: 4 });
    expect(objectives.signup).toBeCloseTo(p.costPerSignupUsd!, 6);
    expect(objectives.meetingBooked).toBeCloseTo(p.costPerMeetingBookedUsd!, 6);
    expect(objectives.websitePurchase).toBeCloseTo(p.costPerPurchaseUsd!, 6);
    for (const g of OBJECTIVES) expect(g in objectives).toBe(true);
  });

  it("IS the window→∞ limit of the trend — matches a single trend point whose window spans all history", () => {
    // 3 days, 2 clicks + 1 reply + $2/day → pooled 6 clicks / 3 replies / $6.
    const spendByDay = new Map<string, number>([["2026-07-06", 2], ["2026-07-07", 2], ["2026-07-08", 2]]);
    const outcomesByDay = new Map<string, DayOutcome>([
      ["2026-07-06", { clicks: 2, replies: 1 }],
      ["2026-07-07", { clicks: 2, replies: 1 }],
      ["2026-07-08", { clicks: 2, replies: 1 }],
    ]);
    // A trend window large enough to swallow ALL history (windowOutcomes above the total).
    const trend = buildCostPerOutcomeTrend({
      objective: "signup", todayIso: "2026-07-08", days: 1, windowOutcomes: 1_000_000,
      maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    const lifetime = buildLifetimeObjectiveAverages({
      totalSpentUsd: 6, totalClicks: 6, totalPositiveReplies: 3, fleetEcon,
    });
    expect(lifetime.signup).toBeCloseTo(trend[0].costPerOutcomeUsd!, 6);
  });

  it("null (never a false $0) when a denominator is 0", () => {
    const objectives = buildLifetimeObjectiveAverages({
      totalSpentUsd: 100, totalClicks: 0, totalPositiveReplies: 0, fleetEcon,
    });
    expect(objectives.websiteVisit).toBeNull();
    expect(objectives.positiveReply).toBeNull();
    expect(objectives.signup).toBeNull();
  });

  it("null economics → all objectives null (cold start)", () => {
    const objectives = buildLifetimeObjectiveAverages({
      totalSpentUsd: 400, totalClicks: 200, totalPositiveReplies: 100, fleetEcon: null,
    });
    for (const g of OBJECTIVES) expect(objectives[g]).toBeNull();
  });
});

describe("buildCostPerOutcomeTrend", () => {
  const fleetEcon = buildLenientProjectionEconomics(FULL_ECON);
  // 5 days of history, 2 clicks/day, $2 spend/day → CPC steady at $1.
  const spendByDay = new Map<string, number>([
    ["2026-07-04", 2], ["2026-07-05", 2], ["2026-07-06", 2], ["2026-07-07", 2], ["2026-07-08", 2],
  ]);
  const outcomesByDay = new Map<string, DayOutcome>([
    ["2026-07-04", { clicks: 2, replies: 1 }],
    ["2026-07-05", { clicks: 2, replies: 1 }],
    ["2026-07-06", { clicks: 2, replies: 1 }],
    ["2026-07-07", { clicks: 2, replies: 1 }],
    ["2026-07-08", { clicks: 2, replies: 1 }],
  ]);

  it("emits one dense point per display day, anchored newest-last", () => {
    const points = buildCostPerOutcomeTrend({
      objective: "websiteVisit", todayIso: "2026-07-08", days: 3, windowOutcomes: 4,
      maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.date)).toEqual(["2026-07-06", "2026-07-07", "2026-07-08"]);
  });

  it("CPC moving average = window spend / window clicks; window spans ~windowOutcomes clicks", () => {
    const points = buildCostPerOutcomeTrend({
      objective: "websiteVisit", todayIso: "2026-07-08", days: 1, windowOutcomes: 4,
      maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    const p = points[0];
    // window needs ≥4 clicks: 2026-07-08 (2) + 2026-07-07 (2) = 4 → spans 2 days, spend $4, clicks 4 → CPC $1.
    expect(p.windowOutcomeCount).toBe(4);
    expect(p.windowSpentUsd).toBe(4);
    expect(p.windowStartDate).toBe("2026-07-07");
    expect(p.costPerOutcomeUsd).toBeCloseTo(1, 6);
  });

  it("projected objective (signup) trend = fleet-econ projection of the window unit cost", () => {
    const points = buildCostPerOutcomeTrend({
      objective: "signup", todayIso: "2026-07-08", days: 1, windowOutcomes: 4,
      maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    // base outcome = clicks → window spans 2 days: spend $4, clicks 4 (clickUsd $1), replies 2 (replyUsd $2).
    const expected = projectOutcomeCosts(fleetEcon, { clickUsd: 1, replyUsd: 2 }).costPerSignupUsd;
    expect(points[0].costPerOutcomeUsd).toBeCloseTo(expected!, 6);
  });

  it("cost is null on a day whose window has zero outcomes (never a false $0)", () => {
    const points = buildCostPerOutcomeTrend({
      objective: "websiteVisit", todayIso: "2026-07-08", days: 1, windowOutcomes: 4,
      maxLookbackDays: 30, spendByDay: new Map(), outcomesByDay: new Map(), fleetEcon,
    });
    expect(points[0].costPerOutcomeUsd).toBeNull();
    expect(points[0].windowOutcomeCount).toBe(0);
  });

  it("null economics → all points null cost", () => {
    const points = buildCostPerOutcomeTrend({
      objective: "signup", todayIso: "2026-07-08", days: 2, windowOutcomes: 4,
      maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon: null,
    });
    expect(points.every((p) => p.costPerOutcomeUsd === null)).toBe(true);
  });
});

describe("recentWindowCostPerOutcome", () => {
  const fleetEcon = buildLenientProjectionEconomics(FULL_ECON);
  // 5 days of history, 2 clicks/day, $2 spend/day → CPC steady at $1; replies 1/day.
  const spendByDay = new Map<string, number>([
    ["2026-07-04", 2], ["2026-07-05", 2], ["2026-07-06", 2], ["2026-07-07", 2], ["2026-07-08", 2],
  ]);
  const outcomesByDay = new Map<string, DayOutcome>([
    ["2026-07-04", { clicks: 2, replies: 1 }],
    ["2026-07-05", { clicks: 2, replies: 1 }],
    ["2026-07-06", { clicks: 2, replies: 1 }],
    ["2026-07-07", { clicks: 2, replies: 1 }],
    ["2026-07-08", { clicks: 2, replies: 1 }],
  ]);

  it("= the today-anchored point of the fleet trend (same window, one dynasty)", () => {
    const recent = recentWindowCostPerOutcome({
      objective: "websiteVisit", todayIso: "2026-07-08", windowOutcomes: 4, maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    const trend = buildCostPerOutcomeTrend({
      objective: "websiteVisit", todayIso: "2026-07-08", days: 1, windowOutcomes: 4, maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    expect(recent).toBeCloseTo(trend[0].costPerOutcomeUsd!, 9);
    expect(recent).toBeCloseTo(1, 6); // window spans 2 days: $4 / 4 clicks = $1
  });

  it("projects a projected objective (signup) through the fleet economics", () => {
    const recent = recentWindowCostPerOutcome({
      objective: "signup", todayIso: "2026-07-08", windowOutcomes: 4, maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon,
    });
    const expected = projectOutcomeCosts(fleetEcon, { clickUsd: 1, replyUsd: 2 }).costPerSignupUsd;
    expect(recent).toBeCloseTo(expected!, 6);
  });

  it("null (never a false $0) when the recent window has zero base outcomes", () => {
    const recent = recentWindowCostPerOutcome({
      objective: "websiteVisit", todayIso: "2026-07-08", windowOutcomes: 4, maxLookbackDays: 30, spendByDay: new Map(), outcomesByDay: new Map(), fleetEcon,
    });
    expect(recent).toBeNull();
  });

  it("null when fleet economics are absent (cold start)", () => {
    const recent = recentWindowCostPerOutcome({
      objective: "signup", todayIso: "2026-07-08", windowOutcomes: 4, maxLookbackDays: 30, spendByDay, outcomesByDay, fleetEcon: null,
    });
    expect(recent).toBeNull();
  });
});

describe("buildWorkflowCostPerOutcome", () => {
  const fleetEcon = buildLenientProjectionEconomics(FULL_ECON);

  it("0-outcome workflow floors to its OWN spend (crossOrg top grain, NOT a cross-workflow pool), sorts by spend desc", () => {
    const rows = buildWorkflowCostPerOutcome({
      objective: "websiteVisit",
      rows: [
        { workflowDynastySlug: "small", workflowDynastyName: "Small", spentUsd: 10, clicks: 5, replies: 0 },
        { workflowDynastySlug: "big-noclicks", workflowDynastyName: "Big", spentUsd: 100, clicks: 0, replies: 0 },
        { workflowDynastySlug: "husk", workflowDynastyName: "Husk", spentUsd: 3, clicks: 0, replies: 0 },
      ],
      fleetEcon,
      projectedFloor: projectedCostPerOutcome,
    });
    // sorted by spend desc → big, small, husk
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["big-noclicks", "small", "husk"]);
    // big has 0 clicks → CPC floored to its OWN spend max(100, 0) = 100 (never null)
    expect(rows[0].costPerOutcomeUsd).toBe(100);
    // small has 5 clicks / $10 → real ratio CPC = $2
    expect(rows[1].costPerOutcomeUsd).toBe(2);
    // husk: 0 clicks, spent $3 → floors to its OWN spend $3, NOT a fleet pooled average — this is why a
    // "best per outcome" consumer must exclude 0-outcome workflows (else this $3 husk wins with 0 clicks).
    expect(rows[2].costPerOutcomeUsd).toBe(3);
  });

  it("null economics → costPerOutcomeUsd null (cold start)", () => {
    const rows = buildWorkflowCostPerOutcome({
      objective: "signup",
      rows: [{ workflowDynastySlug: "w", workflowDynastyName: "W", spentUsd: 10, clicks: 5, replies: 1 }],
      fleetEcon: null,
      projectedFloor: projectedCostPerOutcome,
    });
    expect(rows[0].costPerOutcomeUsd).toBeNull();
  });

  it("threads recentByDynasty onto each row; absent dynasty → recentCostPerOutcomeUsd null", () => {
    const rows = buildWorkflowCostPerOutcome({
      objective: "websiteVisit",
      rows: [
        { workflowDynastySlug: "a", workflowDynastyName: "A", spentUsd: 100, clicks: 50, replies: 0 },
        { workflowDynastySlug: "b", workflowDynastyName: "B", spentUsd: 10, clicks: 5, replies: 0 },
      ],
      fleetEcon,
      projectedFloor: projectedCostPerOutcome,
      recentByDynasty: new Map<string, number | null>([["a", 3.5]]), // only 'a' has a recent value
    });
    const a = rows.find((r) => r.workflowDynastySlug === "a")!;
    const b = rows.find((r) => r.workflowDynastySlug === "b")!;
    expect(a.recentCostPerOutcomeUsd).toBe(3.5); // recent distinct from lifetime (spentUsd/clicks = 2)
    expect(a.costPerOutcomeUsd).toBe(2);
    expect(b.recentCostPerOutcomeUsd).toBeNull(); // absent from the map → null
  });

  it("defaults recentCostPerOutcomeUsd to null when recentByDynasty is omitted", () => {
    const rows = buildWorkflowCostPerOutcome({
      objective: "websiteVisit",
      rows: [{ workflowDynastySlug: "a", workflowDynastyName: "A", spentUsd: 10, clicks: 5, replies: 0 }],
      fleetEcon,
      projectedFloor: projectedCostPerOutcome,
    });
    expect(rows[0].recentCostPerOutcomeUsd).toBeNull();
  });
});

// ── Goal-bucketed cost per outcome ───────────────────────────────────────────

import {
  OBJECTIVE_GOAL_BUCKET,
  GOAL_AGNOSTIC_OBJECTIVES,
  isGoalAgnosticObjective,
  goalInObjectiveBucket,
  bucketBrandsForObjective,
  mergeSpendByDay,
  mergeOutcomesByDay,
  buildBucketedLifetimeAverages,
  perBrandCostPerOutcome,
  buildCostPerOutcomeDistribution,
  type BucketedBrand,
} from "./cross-org-cost-per-outcome.js";
import { matchOptimizationGoal, type Goal } from "./goals.js";

function brand(brandId: string, goal: Goal, spend: number, clicks: number, replies: number): BucketedBrand {
  return {
    brandId,
    goal,
    economics: FULL_ECON,
    spendByDay: new Map([["2026-07-08", spend]]),
    outcomesByDay: new Map([["2026-07-08", { clicks, replies }]]),
  };
}

describe("matchOptimizationGoal (brand-service stored enum → Goal)", () => {
  it("maps every stored OptimizationGoal spelling", () => {
    expect(matchOptimizationGoal("signups")).toBe("signup");
    expect(matchOptimizationGoal("booked_meetings")).toBe("meetingBooked");
    expect(matchOptimizationGoal("sales")).toBe("sales");
    expect(matchOptimizationGoal("website_visits")).toBe("websiteVisit");
    expect(matchOptimizationGoal("positive_replies")).toBe("positiveReply");
    expect(matchOptimizationGoal("form_submissions")).toBe("formSubmission");
    expect(matchOptimizationGoal("website_purchase")).toBe("websitePurchase");
    expect(matchOptimizationGoal("sales")).toBe("sales");
  });
  it("also tolerates the runtime camel spellings", () => {
    expect(matchOptimizationGoal("signup")).toBe("signup");
    expect(matchOptimizationGoal("meetingBooked")).toBe("meetingBooked");
    expect(matchOptimizationGoal("purchase")).toBe("websitePurchase");
  });
  it("returns null for an unrecognised value", () => {
    expect(matchOptimizationGoal("nonsense")).toBeNull();
    expect(matchOptimizationGoal("")).toBeNull();
  });
});

describe("OBJECTIVE_GOAL_BUCKET", () => {
  it("cpc = every click-driven goal except reply-driven + meeting-driven", () => {
    expect(OBJECTIVE_GOAL_BUCKET.websiteVisit).toEqual(["websiteVisit", "signup", "formSubmission"]);
    expect(OBJECTIVE_GOAL_BUCKET.websiteVisit).not.toContain("positiveReply");
    expect(OBJECTIVE_GOAL_BUCKET.websiteVisit).not.toContain("meetingBooked");
    expect(OBJECTIVE_GOAL_BUCKET.websiteVisit).not.toContain("websitePurchase");
  });
  it("each single-outcome objective is its own goal only", () => {
    expect(OBJECTIVE_GOAL_BUCKET.positiveReply).toEqual(["positiveReply"]);
    expect(OBJECTIVE_GOAL_BUCKET.signup).toEqual(["signup"]);
    expect(OBJECTIVE_GOAL_BUCKET.formSubmission).toEqual(["formSubmission"]);
    expect(OBJECTIVE_GOAL_BUCKET.websitePurchase).toEqual(["websitePurchase"]);
    expect(OBJECTIVE_GOAL_BUCKET.sales).toEqual(["sales"]);
  });
  it("meeting bucket = meetingBooked + purchase (purchase closes via meeting)", () => {
    expect(OBJECTIVE_GOAL_BUCKET.meetingBooked).toEqual(["meetingBooked", "websitePurchase"]);
  });
  it("goalInObjectiveBucket agrees with the table", () => {
    expect(goalInObjectiveBucket("websiteVisit", "signup")).toBe(true);
    expect(goalInObjectiveBucket("websiteVisit", "positiveReply")).toBe(false);
    expect(goalInObjectiveBucket("meetingBooked", "websitePurchase")).toBe(true);
    expect(goalInObjectiveBucket("signup", "websitePurchase")).toBe(false);
  });
});

describe("bucketBrandsForObjective + merge", () => {
  const brands = [
    brand("b-visit", "websiteVisit", 100, 50, 0),
    brand("b-signup", "signup", 200, 40, 0),
    brand("b-reply", "positiveReply", 300, 5, 20),
    brand("b-meeting", "meetingBooked", 400, 10, 3),
    brand("b-purchase", "websitePurchase", 500, 8, 2),
  ];

  it("cpc bucket excludes reply + meeting + purchase brands", () => {
    const bucket = bucketBrandsForObjective(brands, "websiteVisit");
    expect(bucket.map((b) => b.brandId).sort()).toEqual(["b-signup", "b-visit"]);
    // spend + clicks summed over ONLY the click-driven brands
    expect(mergeSpendByDay(bucket).get("2026-07-08")).toBe(300); // 100 + 200
    expect(mergeOutcomesByDay(bucket).get("2026-07-08")).toEqual({ clicks: 90, replies: 0 });
  });

  it("signup bucket = signup brand only (purchase excluded)", () => {
    const bucket = bucketBrandsForObjective(brands, "signup");
    expect(bucket.map((b) => b.brandId)).toEqual(["b-signup"]);
  });

  it("meeting bucket = meeting + purchase brands", () => {
    const bucket = bucketBrandsForObjective(brands, "meetingBooked");
    expect(bucket.map((b) => b.brandId).sort()).toEqual(["b-meeting", "b-purchase"]);
    expect(mergeSpendByDay(bucket).get("2026-07-08")).toBe(900); // 400 + 500
  });

  it("positiveReply is GOAL-AGNOSTIC: pools replies across ALL brands, not just reply-goal brands", () => {
    // A positive reply is produced by every cold-email brand regardless of its declared goal, so the
    // bucket = the whole dataset (never filtered to optimizationGoal=positiveReply).
    const bucket = bucketBrandsForObjective(brands, "positiveReply");
    expect(bucket.map((b) => b.brandId).sort()).toEqual([
      "b-meeting",
      "b-purchase",
      "b-reply",
      "b-signup",
      "b-visit",
    ]);
    // clicks 50+40+5+10+8 = 113, replies 0+0+20+3+2 = 25 — every brand's outcomes counted
    expect(mergeOutcomesByDay(bucket).get("2026-07-08")).toEqual({ clicks: 113, replies: 25 });
    // spend pooled over every brand: 100+200+300+400+500 = 1500
    expect(mergeSpendByDay(bucket).get("2026-07-08")).toBe(1500);
  });
});

describe("isGoalAgnosticObjective / GOAL_AGNOSTIC_OBJECTIVES", () => {
  it("positiveReply is goal-agnostic; websiteVisit + projected + whatsapp stay goal-bucketed", () => {
    expect(isGoalAgnosticObjective("positiveReply")).toBe(true);
    expect(GOAL_AGNOSTIC_OBJECTIVES).toEqual(["positiveReply"]);
    for (const g of ["websiteVisit", "signup", "formSubmission", "meetingBooked", "websitePurchase", "sales", "whatsappConversation"] as const) {
      expect(isGoalAgnosticObjective(g)).toBe(false);
    }
  });
});

describe("buildBucketedLifetimeAverages", () => {
  it("cost-per-click uses ONLY click-driven brands' pooled spend/clicks (websiteVisit stays bucketed)", () => {
    const brands = [
      brand("b-visit", "websiteVisit", 100, 50, 0),
      brand("b-reply", "positiveReply", 900, 0, 30),
    ];
    const avgs = buildBucketedLifetimeAverages(brands);
    // websiteVisit = pooled CPC over the visit brand only: 100 / 50 = 2 (reply brand's $900 excluded)
    expect(avgs.websiteVisit).toBeCloseTo(2, 5);
  });

  it("positiveReply is GOAL-AGNOSTIC: pooled CPPR over EVERY brand's spend ÷ replies, not just reply brands", () => {
    const brands = [
      brand("b-visit", "websiteVisit", 100, 50, 0), // 0 replies — its $100 STILL counts toward fleet CPPR
      brand("b-reply", "positiveReply", 900, 0, 30),
    ];
    const avgs = buildBucketedLifetimeAverages(brands);
    // pooled over ALL brands: total spend 1000 ÷ total replies 30 = 33.33 (the honest fleet-wide cost —
    // the click brand's spend is real money that produced only its incidental replies)
    expect(avgs.positiveReply).toBeCloseTo(1000 / 30, 5);
  });

  it("positiveReply null when NO brand produced any reply, never a false $0", () => {
    const brands = [brand("b-visit", "websiteVisit", 100, 50, 0)]; // 0 replies fleet-wide → 0 denominator
    const avgs = buildBucketedLifetimeAverages(brands);
    expect(avgs.positiveReply).toBeNull();
  });
});

describe("perBrandCostPerOutcome", () => {
  it("one data point per brand = its pooled cost-per-outcome (CPC), 0-outcome brands dropped", () => {
    const brands = [
      brand("b1", "websiteVisit", 100, 50, 0), // CPC 2
      brand("b2", "websiteVisit", 300, 50, 0), // CPC 6
      brand("b3", "websiteVisit", 100, 0, 0), // 0 clicks → no data point (never a false $0)
    ];
    const values = perBrandCostPerOutcome(brands, "websiteVisit").sort((a, b) => a - b);
    expect(values).toEqual([2, 6]);
  });

  it("positiveReply uses each brand's CPPR", () => {
    const brands = [
      brand("b1", "positiveReply", 200, 0, 10), // CPPR 20
      brand("b2", "positiveReply", 300, 0, 10), // CPPR 30
    ];
    const values = perBrandCostPerOutcome(brands, "positiveReply").sort((a, b) => a - b);
    expect(values).toEqual([20, 30]);
  });
});

describe("buildCostPerOutcomeDistribution", () => {
  const visitBrands = (cpcs: number[]): BucketedBrand[] =>
    // clicks fixed at 100 → spend = cpc*100 gives that CPC
    cpcs.map((cpc, i) => brand(`b${i}`, "websiteVisit", cpc * 100, 100, 0));

  it("empty/soft below the minimum brand count — buckets [] + all scalars null, brandCount reported", () => {
    const dist = buildCostPerOutcomeDistribution({ objective: "websiteVisit", brands: visitBrands([5]), bucketCount: 10, minBrands: 2 });
    expect(dist.brandCount).toBe(1);
    expect(dist.buckets).toEqual([]);
    expect(dist.mean).toBeNull();
    expect(dist.median).toBeNull();
    expect(dist.min).toBeNull();
    expect(dist.max).toBeNull();
    expect(dist.stddev).toBeNull();
  });

  it("histogram bars + central tendency + spread over per-brand CPCs", () => {
    // CPCs 1..10 → mean 5.5, median 5.5, min 1, max 10
    const dist = buildCostPerOutcomeDistribution({
      objective: "websiteVisit",
      brands: visitBrands([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      bucketCount: 10,
      minBrands: 2,
    });
    expect(dist.brandCount).toBe(10);
    expect(dist.mean).toBeCloseTo(5.5, 6);
    expect(dist.median).toBeCloseTo(5.5, 6);
    expect(dist.min).toBe(1);
    expect(dist.max).toBe(10);
    expect(dist.p25).toBeCloseTo(3.25, 6);
    expect(dist.p75).toBeCloseTo(7.75, 6);
    expect(dist.buckets).toHaveLength(10);
    // every value binned exactly once — counts sum to brandCount, no data escapes the histogram
    expect(dist.buckets.reduce((a, b) => a + b.count, 0)).toBe(10);
    // first bar starts at min, last bar ends at max
    expect(dist.buckets[0].minUsd).toBeCloseTo(1, 6);
    expect(dist.buckets[9].maxUsd).toBeCloseTo(10, 6);
  });

  it("all-equal values collapse to a single bar (max == min)", () => {
    const dist = buildCostPerOutcomeDistribution({ objective: "websiteVisit", brands: visitBrands([4, 4, 4]), bucketCount: 10, minBrands: 2 });
    expect(dist.brandCount).toBe(3);
    expect(dist.buckets).toEqual([{ minUsd: 4, maxUsd: 4, count: 3 }]);
    expect(dist.mean).toBe(4);
    expect(dist.stddev).toBe(0);
    expect(dist.min).toBe(4);
    expect(dist.max).toBe(4);
  });

  it("goal-bucketed inputs excluded upstream: callers pass bucketBrandsForObjective — off-goal brands never contribute", () => {
    // a positiveReply brand carries no CPC data point even if it has spend
    const brands = [
      brand("b-visit-1", "websiteVisit", 200, 100, 0), // CPC 2
      brand("b-visit-2", "websiteVisit", 600, 100, 0), // CPC 6
      brand("b-reply", "positiveReply", 9999, 0, 40), // 0 clicks → excluded from CPC
    ];
    const dist = buildCostPerOutcomeDistribution({
      objective: "websiteVisit",
      brands: bucketBrandsForObjective(brands, "websiteVisit"),
      bucketCount: 5,
      minBrands: 2,
    });
    expect(dist.brandCount).toBe(2);
    expect(dist.min).toBe(2);
    expect(dist.max).toBe(6);
  });
});
