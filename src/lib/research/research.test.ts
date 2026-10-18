import { describe, expect, it } from "vitest";
import { compareVerdict, exactP, headlineFor, likeForLike, poissonInterval } from "./verdict.js";
import { bucketOf, type SlugCell } from "./buckets.js";
import { buildSlugCells } from "./slug-cells.js";
import { assembleResearch, UNAVAILABLE, workflowBuckets, type ColdEmailPipeInput } from "./assemble.js";
import { researchConclusions, researchMeasuredStudies } from "./conclusions.js";
import { modelLabel, templateLabel } from "./format.js";
import type { LegWorkflowRankingRow } from "../leg-workflow-ranking.js";
import type { MeetingBookingBeforeAfter } from "../meeting-booking-before-after.js";

/** Today's 45 study ids on the staff Research page (snapshot of 2026-10-18 14:18). */
const PAGE_IDS = [
  ...["llm-roi", "llm-rate", "cost-over-time", "followups-roi", "followups-rate", "opens-roi", "opens-rate", "template-roi", "template-rate", "naming-rate", "naming-roi", "layout-roi", "opening-roi", "dash-roi", "weekday-rate", "hour-rate", "workflow-roi", "workflow-rate"].map((s) => `cold-email-positive-reply-${s}`),
  ...["llm-roi", "llm-rate", "cost-over-time", "followups-roi", "followups-rate", "opens-roi", "opens-rate", "template-roi", "template-rate", "layout-roi", "opening-roi", "dash-roi", "hour-rate", "workflow-roi", "workflow-rate"].map((s) => `cold-email-website-visit-${s}`),
  ...["llm", "template", "followups", "cost", "workflow-roi", "workflow-rate"].map((s) => `meeting-booking-${s}`),
  "meeting-cost",
  "meeting-ai-before-after",
  ...["volume", "screen-decline", "screen-price", "machine-replies"].map((s) => `jev-${s}`),
];

describe("verdict (ported from verdict.mjs)", () => {
  it("exact two-sided p of a clear gap is tiny, of no gap is 1", () => {
    expect(exactP(50, 1000, 10, 1000)).toBeLessThan(0.001);
    expect(exactP(10, 1000, 10, 1000)).toBeCloseTo(1, 5);
  });
  it("a leader under 5 outcomes is noise", () => {
    const v = compareVerdict({ a: { label: "A", outcomes: 4, exposure: 100, spend: 10 }, b: { label: "B", outcomes: 0, exposure: 100, spend: 10 }, goal: "rate", comparisons: 1, strata: null, noun: "reply", nouns: "replies" });
    expect(v.kind).toBe("noise");
  });
  it("a crude gap that holds on the same clients in the same months is a conclusion", () => {
    const strata = {
      A: { "o1|2026-09": { exposure: 1000, outcomes: 40, spend: 100 }, "o2|2026-09": { exposure: 1000, outcomes: 40, spend: 100 } },
      B: { "o1|2026-09": { exposure: 1000, outcomes: 5, spend: 100 }, "o2|2026-09": { exposure: 1000, outcomes: 5, spend: 100 } },
    };
    const v = compareVerdict({ a: { label: "A", outcomes: 80, exposure: 2000, spend: 200 }, b: { label: "B", outcomes: 10, exposure: 2000, spend: 200 }, goal: "rate", comparisons: 1, strata, noun: "reply", nouns: "replies" });
    expect(v.kind).toBe("conclusion");
  });
  it("without strata the best a crude gap reaches is a signal, saying why", () => {
    const v = compareVerdict({ a: { label: "A", outcomes: 80, exposure: 2000, spend: 200 }, b: { label: "B", outcomes: 10, exposure: 2000, spend: 200 }, goal: "rate", comparisons: 1, strata: null, noun: "reply", nouns: "replies" });
    expect(v.kind).toBe("signal");
    expect(v.reason).toMatch(/not split by client and month/);
  });
  it("headline verbs follow the word", () => {
    expect(headlineFor("X wins at $5 per reply.", "noise")).toBe("X leads at $5 per reply. Noise so far.");
    expect(headlineFor("X wins at $5 per reply.", "conclusion")).toBe("X wins at $5 per reply.");
  });
  it("like-for-like ratio is ~1 on identical arms; the Poisson interval brackets the count", () => {
    const l = likeForLike([[{ exposure: 100, outcomes: 10, spend: 50 }, { exposure: 100, outcomes: 10, spend: 50 }]]);
    expect(l.rate!.ratio).toBeCloseTo(1, 6);
    const [lo, hi] = poissonInterval(10);
    expect(lo).toBeLessThan(10);
    expect(hi).toBeGreaterThan(10);
  });
});

describe("labels", () => {
  it("model ids read in words by one rule", () => {
    expect(modelLabel("gemini-3.5-flash-lite")).toBe("Gemini 3.5 Flash-Lite");
    expect(modelLabel("gemini-3.1-pro-preview")).toBe("Gemini 3.1 Pro");
    expect(modelLabel("claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelLabel("gpt-6-astra")).toBe("GPT-6 Astra");
    expect(modelLabel("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
  });
  it("template ids read in words", () => {
    expect(templateLabel("cold-email-v35")).toBe("Cold email v35");
    expect(templateLabel("blind-discovery-email-v26")).toBe("Blind discovery v26");
  });
});

const half = (spentUsd: number, contacted: number, outcomes: number, month = "2026-09", org = "o1") => ({
  figures: { spentUsd, contacted, outcomes },
  months: { [month]: { spentUsd, contacted, outcomes } },
  strata: { [`${org}|${month}`]: { spentUsd, contacted, outcomes } },
});

describe("buckets", () => {
  it("a bucket under the bar reads flash and Learning; its months add up to the bar", () => {
    const cells: SlugCell[] = [{ slug: "wf-a-v1", flash: half(100, 1000, 12), mature: half(60, 500, 4) }];
    const b = bucketOf({ key: "wf-a", label: "A", legKey: "start_to_website_visit", cells });
    expect(b.basis).toBe("flash");
    expect(b.learning).toBe(true);
    expect(b.figures).toEqual({ spentUsd: 100, contacted: 1000, outcomes: 12 });
    expect(b.months!.reduce((t, m) => t + m.outcomes, 0)).toBeCloseTo(12, 9);
  });
  it("a ranking override is what the bar states (the Workflows page's figure), dated parts scaled onto it", () => {
    const cells: SlugCell[] = [{ slug: "rampart-v3", flash: half(130, 760, 16), mature: half(127.1, 720, 15) }];
    const b = bucketOf({ key: "rampart", label: "Rampart", legKey: "start_to_website_visit", cells, override: { basis: "mature", figures: { spentUsd: 127.1, contacted: 720, outcomes: 15 }, learning: false } });
    expect(b.figures.spentUsd / b.figures.outcomes).toBeCloseTo(8.4733, 3);
    expect(b.months![0]!.spentUsd).toBeCloseTo(127.1, 9);
  });
});

describe("slug cells", () => {
  it("dates spend by run month and persons by serve month, mature cut at the cutoff day", () => {
    const cells = buildSlugCells({
      legKey: "start_to_conversation",
      screened: false,
      signal: "positiveReply",
      cutoffDay: "2026-09-27",
      flash: { costGroups: [{ dimensions: { workflowSlug: "a-v1" }, totalCostInUsdCents: "10000", runCount: 3 }], emailStats: new Map([["a-v1", { recipientsContacted: 300, recipientsRepliesPositive: 3 }]]) },
      mature: { costGroups: [{ dimensions: { workflowSlug: "a-v1" }, totalCostInUsdCents: "8000", runCount: 2 }], emailStats: new Map([["a-v1", { recipientsContacted: 200, recipientsRepliesPositive: 2 }]]) },
      persons: [
        { orgId: "o1", campaignId: "c1", workflowSlug: "a-v1", servedDay: "2026-09-10", contacted: 200, clicked: 0, positiveReplies: 2, screenedContacted: 0, humanClicked: 0 },
        { orgId: "o1", campaignId: "c1", workflowSlug: "a-v1", servedDay: "2026-10-01", contacted: 100, clicked: 0, positiveReplies: 1, screenedContacted: 0, humanClicked: 0 },
      ],
      spend: [
        { workflowSlug: "a-v1", campaignId: "c1", month: "2026-09", beforeCutoff: true, spentUsd: 80 },
        { workflowSlug: "a-v1", campaignId: "c1", month: "2026-10", beforeCutoff: false, spentUsd: 20 },
      ],
      orgOfCampaign: new Map([["c1", "o1"]]),
    });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.flash.figures).toEqual({ spentUsd: 100, contacted: 300, outcomes: 3 });
    expect(cells[0]!.mature!.figures).toEqual({ spentUsd: 80, contacted: 200, outcomes: 2 });
    expect(Object.keys(cells[0]!.mature!.months)).toEqual(["2026-09"]);
    expect(cells[0]!.flash.strata["o1|2026-10"]).toEqual({ spentUsd: 20, contacted: 100, outcomes: 1 });
  });
});

const row = (slug: string, cost: { spentUsd: number; contacted: number; outcomes: number }, mature: boolean): LegWorkflowRankingRow => ({
  rank: 1,
  workflowDynastySlug: slug,
  workflowDynastyName: `Sales Cold Email Outreach ${slug}`,
  assignment: "active",
  executable: true,
  selectable: true,
  isMature: mature,
  basis: mature ? "mature" : "flash",
  costPerOutcomeUsd: cost.outcomes ? cost.spentUsd / cost.outcomes : null,
  conversionRatePct: cost.contacted ? (100 * cost.outcomes) / cost.contacted : null,
  outcomes: cost.outcomes,
  contacted: cost.contacted,
  spentUsd: cost.spentUsd,
  roiMultiple: null,
  goesFirst: false,
  moneyGoesHere: false,
  explorePriceUsd: null,
  place: "mature",
});

const pipe = (legKey: string, rows: LegWorkflowRankingRow[]): ColdEmailPipeInput => ({
  legKey,
  durationDays: 21,
  outcomesRequired: legKey === "start_to_conversation" ? 1 : 10,
  cutoffDay: "2026-09-27",
  cells: rows.map((r) => ({ slug: `${r.workflowDynastySlug}-v1`, flash: half(r.spentUsd, r.contacted, r.outcomes), mature: half(r.spentUsd, r.contacted, r.outcomes) })),
  dynastyOf: new Map(rows.map((r) => [`${r.workflowDynastySlug}-v1`, r.workflowDynastySlug])),
  labelOf: (d) => d,
  rankingRows: rows,
});

const beforeAfter: MeetingBookingBeforeAfter = {
  legKey: "conversation_to_meeting_booked",
  basis: "positive_repliers_by_first_reply_vs_ai_go_live",
  brands: [],
  fleet: {
    brandCount: 2,
    before: { positiveReplyPeople: 40, bookedPeople: 6, ratePct: 15, bookedBy: { aiMeetingBooking: 0, yourTeamMeetingBooking: 6, other: 0, unknown: 0 }, sameHorizon: { days: 30, positiveReplyPeople: 28, bookedPeople: 4, ratePct: 14.29 } },
    after: { positiveReplyPeople: 20, bookedPeople: 3, ratePct: 15, bookedBy: { aiMeetingBooking: 3, yourTeamMeetingBooking: 0, other: 0, unknown: 0 }, sameHorizon: { days: 30, positiveReplyPeople: 10, bookedPeople: 2, ratePct: 20 } },
    changePctPoints: null,
    relativeChangePct: null,
    bookedRequiredPerWindow: 10,
    unavailableReason: "not_enough_meetings",
  },
  unavailableReason: null,
};

describe("assembleResearch", () => {
  const rampart = row("rampart", { spentUsd: 127.1, contacted: 720, outcomes: 15 }, true);
  const acamar = row("acamar", { spentUsd: 18.26, contacted: 108, outcomes: 1 }, false);
  const file = assembleResearch({
    costBasis: "user",
    now: new Date("2026-10-18T15:00:00Z"),
    unpricedBilledUsd: 0,
    reply: pipe("start_to_conversation", [row("azalea", { spentUsd: 910.9, contacted: 3423, outcomes: 5 }, true), row("belel", { spentUsd: 36.4, contacted: 202, outcomes: 1 }, false)]),
    visit: pipe("start_to_website_visit", [rampart, acamar]),
    meeting: { outcomesRequired: 10, rankingRows: [row("rhodium", { spentUsd: 0.9, contacted: 2, outcomes: 0 }, false)], unattributableCampaigns: 1 },
    beforeAfter,
    meetingOutcomesRequired: 10,
  });

  it("every one of today's 45 study ids is served or listed unavailable, never both, never neither", () => {
    const served = new Set(file.studies.map((s) => s.id));
    const waiting = new Set(file.unavailable.map((u) => u.id));
    for (const id of PAGE_IDS) expect(served.has(id) !== waiting.has(id), id).toBe(true);
    expect(served.size + waiting.size).toBe(PAGE_IDS.length);
    expect(UNAVAILABLE.length).toBe(waiting.size);
  });

  it("the website-visit workflow ROI study states the ranking's cost for the same workflow (Rampart)", () => {
    const st = file.studies.find((s) => s.id === "cold-email-website-visit-workflow-roi")!;
    const bar = st.charts[0]!.points.find((p) => p.key === "rampart")!;
    expect(bar.value).toBe(Number((rampart.costPerOutcomeUsd as number).toFixed(2)));
    expect(st.winner).toBe("rampart");
  });

  it("every study carries a verdict; a measured headline follows it", () => {
    for (const s of file.studies) {
      expect(["conclusion", "signal", "noise"]).toContain(s.verdict.kind);
      if (s.status === "measured" && s.verdict.kind !== "conclusion") expect(s.headline).toMatch(/(Noise so far\.|A signal to confirm)/);
    }
  });

  it("conclusions quote only conclusion studies on the billed basis", () => {
    const c = researchConclusions(file);
    expect(c.conclusions.every((x) => file.studies.find((s) => s.id === x.id)!.verdict.kind === "conclusion")).toBe(true);
    const m = researchMeasuredStudies(file);
    expect(m.studies.every((x) => x.quotable === (x.verdict?.kind === "conclusion"))).toBe(true);
    expect(() => researchConclusions({ ...file, costBasis: "actual" })).toThrow(/billed/);
  });

  it("the actual basis reads bars off the cells (no ranking) and states the meeting studies are not on vendor cost", () => {
    const actual = assembleResearch({
      costBasis: "actual",
      now: new Date("2026-10-18T15:00:00Z"),
      unpricedBilledUsd: 12.5,
      reply: { ...pipe("start_to_conversation", [row("azalea", { spentUsd: 100, contacted: 3423, outcomes: 5 }, true)]), rankingRows: null },
      visit: { ...pipe("start_to_website_visit", [rampart]), rankingRows: null },
      meeting: { outcomesRequired: 10, rankingRows: null, unattributableCampaigns: 0 },
      beforeAfter,
      meetingOutcomesRequired: 10,
    });
    expect(actual.unpricedBilledUsd).toBe(12.5);
    expect(actual.studies.find((s) => s.id === "meeting-booking-cost")!.headline).toMatch(/vendor cost/);
    expect(workflowBuckets({ ...pipe("start_to_website_visit", [rampart]), rankingRows: null })[0]!.figures.outcomes).toBe(15);
  });
});
