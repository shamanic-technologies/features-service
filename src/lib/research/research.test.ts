import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
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
        { orgId: "o1", campaignId: "c1", workflowSlug: "a-v1", servedDay: "2026-09-10", contacted: 200, clicked: 0, positiveReplies: 2, screenedContacted: 0, humanClicked: 0, generation: null },
        { orgId: "o1", campaignId: "c1", workflowSlug: "a-v1", servedDay: "2026-10-01", contacted: 100, clicked: 0, positiveReplies: 1, screenedContacted: 0, humanClicked: 0, generation: null },
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
    population: { rule: "brands_reporting_meetings", brandsCounted: 2, brandsLeftOut: 3 },
    before: { positiveReplyPeople: 40, bookedPeople: 6, ratePct: 15, bookedBy: { aiMeetingBooking: 0, yourTeamMeetingBooking: 6, other: 0, unknown: 0 }, sameHorizon: { days: 30, positiveReplyPeople: 28, bookedPeople: 4, ratePct: 14.29 } },
    after: { positiveReplyPeople: 20, bookedPeople: 3, ratePct: 15, bookedBy: { aiMeetingBooking: 3, yourTeamMeetingBooking: 0, other: 0, unknown: 0 }, sameHorizon: { days: 30, positiveReplyPeople: 10, bookedPeople: 2, ratePct: 20 } },
    changePctPoints: null,
    relativeChangePct: null,
    bookedRequiredPerWindow: 10,
    unavailableReason: "not_enough_meetings",
  },
  unavailableReason: null,
};

const NO_JEV = { judgments: null, judgmentOrgs: 0, screens: null, screenOrgs: 0, screenAudiences: 0, reveal: null, replies: null };

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
    sends: null,
    generationStudies: [],
    jev: NO_JEV,
  });

  it("every one of today's 45 study ids is served or listed unavailable, never both, never neither", () => {
    const served = new Set(file.studies.map((s) => s.id));
    const waiting = new Set(file.unavailable.map((u) => u.id));
    for (const id of PAGE_IDS) expect(served.has(id) !== waiting.has(id), id).toBe(true);
    expect(served.size + waiting.size).toBe(PAGE_IDS.length);
    expect(UNAVAILABLE.length).toBeGreaterThanOrEqual(waiting.size);
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
      sends: null,
      generationStudies: [],
      jev: NO_JEV,
    });
    expect(actual.unpricedBilledUsd).toBe(12.5);
    expect(actual.studies.find((s) => s.id === "meeting-booking-cost")!.headline).toMatch(/vendor cost/);
    expect(workflowBuckets({ ...pipe("start_to_website_visit", [rampart]), rankingRows: null })[0]!.figures.outcomes).toBe(15);
  });
});

import { followupStudies, opensStudies, timingStudy, type SendGroup, type SendsPipe } from "./sends.js";
import { jevStudies } from "./jev.js";

const terms = {
  pipe: "cold-email-positive-reply" as const,
  noun: "positive reply",
  nounPlural: "positive replies",
  exposureNoun: "people emailed",
  exposureNounOne: "person emailed",
  outcomesRequired: 1,
  partialMonth: null,
  note: "rule",
};
const g = (step: number, emails: number, replies: number, extra: Partial<SendGroup> = {}): SendGroup => ({
  orgId: "o1",
  month: "2026-09",
  step,
  weekday: "Tuesday",
  hour: 10,
  screenable: false,
  emails,
  replies,
  clicks: 0,
  ...extra,
});

describe("follow-ups (marginal ROI)", () => {
  const pipe: SendsPipe = { terms, visit: false, groups: [g(1, 1000, 10), g(2, 900, 6), g(3, 800, 1)], spend: { perEmailUsd: 27, perPersonUsd: 1000 } };
  const [roi, rate] = followupStudies(pipe);
  it("a follow-up costs only its own sending; the first email carries every per-person dollar", () => {
    const bars = roi!.charts[0]!.points;
    expect(bars[0]!.label).toBe("First email");
    // first email: 1000 x $0.01 sending + $1000 per person = $1010 / 10 replies
    expect(bars[0]!.value).toBeCloseTo(101, 2);
    // follow-up 1: 900 x $0.01 = $9 / 6 replies
    expect(bars[1]!.value).toBeCloseTo(1.5, 2);
  });
  it("an email from our own sender adds no per-email charge", () => {
    const own = followupStudies({ ...pipe, groups: pipe.groups.map((x) => ({ ...x, screenable: true })) })[0]!;
    expect(own.charts[0]!.points.find((p) => p.label === "Follow-up 1")).toBeUndefined(); // $0 extra: no price bar
    expect(own.headline).toMatch(/no extra cost/);
  });
  it("sends through the deepest follow-up whose extra reply costs no more than a first email's", () => {
    expect(roi!.winner).toBe("Follow-up 2");
    expect(rate!.result!.display).toBe("1.70%");
  });
});

describe("timing", () => {
  it("ranks days ordinally in the prospect's timezone, with strata per client and month", () => {
    const pipe: SendsPipe = {
      terms,
      visit: false,
      groups: [g(1, 1000, 12, { weekday: "Monday" }), g(1, 1000, 3, { weekday: "Sunday" }), g(1, 500, 0, { weekday: null, hour: null })],
      spend: { perEmailUsd: 0, perPersonUsd: 100 },
    };
    const st = timingStudy(pipe, "weekday")!;
    expect(st.winner).toBe("Monday");
    expect(st.charts[0]!.points.map((p) => p.label)).toEqual(["Monday", "Sunday"]);
    expect(st.conclusion.some((l) => /500 emails whose prospect has no timezone/.test(l))).toBe(true);
  });
  it("states nothing when every bucket is Learning", () => {
    expect(timingStudy({ terms: { ...terms, outcomesRequired: 10 }, visit: false, groups: [g(1, 100, 6)], spend: { perEmailUsd: 0, perPersonUsd: 1 } }, "hour")).toBeNull();
  });
});

describe("open tracking", () => {
  it("is at best a signal: two periods, never a split test", () => {
    const [roi, rate] = opensStudies(terms, { on: { people: 26000, positive: 28, replied: 86, bounced: 400, firstDay: "2026-02-10", lastDay: "2026-06-28" }, off: { people: 30000, positive: 37, replied: 153, bounced: 2700, firstDay: "2026-02-10", lastDay: "2026-09-26" }, unplaced: 20 }, "2026-09-27");
    expect(["signal", "noise"]).toContain(roi!.verdict.kind);
    expect(rate!.verdict.kind).toBe("signal");
    expect(rate!.headline).toMatch(/^Tracking off leads/);
  });
});

describe("typed judgments", () => {
  it("states each measurement, and the vendor basis never relabels a billed price", () => {
    const input = {
      readOn: "2026-10-18",
      judgments: [
        { month: "2026-09", taskName: "judgments", parentServiceName: "lead-service", runCount: 100000, quantity: 5e7, billedCents: 1300 },
        { month: "2026-10", taskName: "platform-judgments", parentServiceName: null, runCount: 87000, quantity: 4e7, billedCents: 1100 },
      ],
      judgmentOrgs: 12,
      screens: [{ month: "2026-10", buckets: { lt20: { passed: 0, declined: 700 }, lt50: { passed: 0, declined: 80 }, lt80: { passed: 100, declined: 0 }, ge80: { passed: 120, declined: 0 } } }],
      screenOrgs: 10,
      screenAudiences: 96,
      reveal: { credits: 1000, billedCents: 18400 },
      replies: { person: 470, outOfOffice: 400, otherAuto: 130, orgs: 20 },
    };
    const billed = jevStudies({ ...input, costBasis: "user" });
    expect(billed.map((s) => s.id)).toEqual(["jev-volume", "jev-screen-decline", "jev-screen-price", "jev-machine-replies"]);
    expect(billed[1]!.headline).toBe("78% of the people Apollo returns are turned away before the paid reveal.");
    expect(billed[3]!.result!.display).toBe("53%");
    const actual = jevStudies({ ...input, costBasis: "actual" });
    expect(actual[0]!.headline).toMatch(/vendor cost/);
    expect(actual[2]!.headline).toMatch(/vendor cost/);
  });
});

import { parseCursor } from "../outreach-facts-copy.js";
describe("outreach facts copy cursor", () => {
  it("reads a bare cursor as copied before the thread fields existed", () => {
    expect(parseCursor("1234")).toEqual({ cursor: "1234", withSequence: false });
    expect(parseCursor(JSON.stringify({ cursor: "99", withSequence: true }))).toEqual({ cursor: "99", withSequence: true });
    expect(parseCursor(null)).toEqual({ cursor: null, withSequence: false });
  });
});

import { splitCellsByGroup } from "./slug-cells.js";
import { generationStudies } from "./generations.js";

describe("what wrote the emails", () => {
  const gen = (model: string, promptType: string, layout = "double_line_breaks") => ({ model, promptType, layout, opening: "greeting", dash: "none" });
  const pb = (slug: string, model: string, tpl: string, contacted: number, replies: number, org = "o1") => ({
    orgId: org, campaignId: "c1", workflowSlug: slug, servedDay: "2026-09-10", contacted, clicked: 0, positiveReplies: replies, screenedContacted: 0, humanClicked: 0, generation: gen(model, tpl),
  });
  const cells: SlugCell[] = [{ slug: "wf-v1", flash: half(300, 300, 6), mature: half(300, 300, 6) }];
  const persons = [pb("wf-v1", "gemini-3.5-flash", "cold-email-v35", 200, 5), pb("wf-v1", "gemini-3.1-pro-preview", "cold-email-v35", 100, 1)];

  it("shares a version's spend, people and outcomes out on what wrote its people's emails", () => {
    const { cells: split } = splitCellsByGroup(cells, persons, { screened: false, signal: "positiveReply", cutoffDay: "2026-09-27" }, (b) => b.generation!.model);
    const flash = split.find((c) => c.slug.endsWith("gemini-3.5-flash"))!;
    expect(flash.mature!.figures.spentUsd).toBeCloseTo(200, 6);
    expect(flash.mature!.figures.outcomes).toBeCloseTo(5, 6);
    const total = split.reduce((a, c) => a + c.mature!.figures.spentUsd, 0);
    expect(total).toBeCloseTo(300, 6);
  });

  it("names models the chat-service way and splits shape studies by tier", () => {
    const studies = generationStudies({
      terms,
      legKey: "start_to_conversation",
      cells,
      persons,
      split: { screened: false, signal: "positiveReply", cutoffDay: "2026-09-27" },
      models: new Map([
        ["gemini-3.5-flash", { label: "Gemini 3.5 Flash", tier: "Flash" as const }],
        ["gemini-3.1-pro-preview", { label: "Gemini 3.1 Pro", tier: "Pro" as const }],
      ]),
      templateTexts: new Map([["cold-email-v35", "Never name the client."]]),
      naming: true,
    });
    const ids = studies.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["cold-email-positive-reply-llm-roi", "cold-email-positive-reply-llm-rate", "cold-email-positive-reply-template-roi", "cold-email-positive-reply-naming-rate", "cold-email-positive-reply-layout-roi", "cold-email-positive-reply-opening-roi", "cold-email-positive-reply-dash-roi"]));
    const llm = studies.find((s) => s.id === "cold-email-positive-reply-llm-roi")!;
    expect(llm.charts[0]!.points.map((p) => p.label)).toEqual(["Gemini 3.5 Flash", "Gemini 3.1 Pro"]);
    expect(llm.charts[0]!.points[0]!.key).toBe("gemini-3.5-flash");
    const layout = studies.find((s) => s.id === "cold-email-positive-reply-layout-roi")!;
    expect(layout.charts.map((c) => c.title.split(":")[0])).toEqual(["All tiers", "Flash tier", "Pro tier"]);
  });
});
