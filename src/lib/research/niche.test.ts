import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import type { SlugCell } from "./buckets.js";
import { nicheStudies, type NicheInput } from "./niche.js";
import { isOurDomain, judgedStateOf, nicheQuestion, stateHashOf, type GradedClient, type NicheGradesRead } from "./niche-grades.js";

// RESEARCH-NICHE-1021: do clients with a very specific B2B niche convert better on cold email?

const terms = (pipe: "cold-email-positive-reply" | "cold-email-website-visit") => ({
  pipe,
  noun: pipe === "cold-email-positive-reply" ? "positive reply" : "website visit",
  nounPlural: pipe === "cold-email-positive-reply" ? "positive replies" : "website visits",
  exposureNoun: "people emailed",
  exposureNounOne: "person emailed",
  outcomesRequired: 1,
  partialMonth: null,
  note: "rule",
});
const half = (spentUsd: number, contacted: number, outcomes: number) => ({
  figures: { spentUsd, contacted, outcomes },
  months: { "2026-09": { spentUsd, contacted, outcomes } },
  strata: { "o1|2026-09": { spentUsd, contacted, outcomes } },
});
// One workflow version that wrote for both clients: 1,000 people, 30 positive replies, $300.
const cells: SlugCell[] = [{ slug: "azalea-v1", flash: half(300, 1000, 30), mature: half(300, 1000, 30) }];
const pb = (orgId: string, campaignId: string, contacted: number, replies: number) => ({
  orgId, campaignId, workflowSlug: "azalea-v1", servedDay: "2026-09-10", contacted, clicked: 0, positiveReplies: replies, screenedContacted: 0, humanClicked: 0, generation: null,
});
const client = (key: string, brandId: string, label: string, grade: GradedClient["grade"]): GradedClient => ({ key, orgId: key, brandId, offerId: "", label, grade, confidence: 0.9 });
const narrow = client("o1", "b1", "Doc Dinners", "narrow");
const broad = client("o2", "b2", "Pocket CMO", "broad");
const grades: NicheGradesRead = {
  byCampaign: new Map([["c1", narrow], ["c2", broad]]),
  clients: [narrow, broad],
  excludedOurs: 1,
  unjudged: { count: 0, lastReason: null },
};
const persons = [pb("o1", "c1", 400, 24), pb("o2", "c2", 500, 6), pb("o3", "c3", 100, 0)];
const pipe = (p: "cold-email-positive-reply" | "cold-email-website-visit") => ({
  terms: terms(p),
  legKey: "start_to_conversation",
  cells,
  persons,
  split: { screened: false, signal: "positiveReply" as const, cutoffDay: "2026-09-27" },
});
const input = (over: Partial<NicheInput> = {}): NicheInput => ({ reply: pipe("cold-email-positive-reply"), visit: pipe("cold-email-website-visit"), grades, ...over });

describe("niche studies", () => {
  it("files each person under their client's grade and states the answer narrow vs broad", () => {
    const studies = nicheStudies(input());
    const rate = studies.find((s) => s.id === "cold-email-positive-reply-niche-rate")!;
    expect(rate.topic).toBe("niche");
    expect(rate.question).toBe("Do clients with a very specific B2B niche get more positive replies?");
    // narrow = 24 of 400 = 6%, broad = 6 of 500 = 1.2%; the ungraded client's 100 people are left out
    const pts = rate.charts[0]!.points;
    expect(pts.map((p) => [p.label, p.display])).toEqual([
      ["Narrow niche", "6.00%"],
      ["Broad", "1.20%"],
    ]);
    expect(rate.conclusion[0]).toContain("5.00x, so a narrower niche converted better");
    expect(rate.conclusion.join(" ")).toContain("Narrow niche (1): Doc Dinners.");
    expect(rate.conclusion.join(" ")).toContain("Broad (1): Pocket CMO.");
    expect(rate.conclusion.join(" ")).toContain("100 people emailed by ungraded clients");
    expect(rate.conclusion.join(" ")).toContain("1 of our own account is left out");
    // one grade per client: never a conclusion
    expect(rate.verdict.kind).not.toBe("conclusion");
  });

  it("states the cost per outcome per grade on the shared spend", () => {
    const roi = nicheStudies(input()).find((s) => s.id === "cold-email-positive-reply-niche-roi")!;
    // $300 shared on 1,000 people: narrow $120 / 24 = $5, broad $150 / 6 = $25
    expect(roi.charts[0]!.points.map((p) => [p.label, p.display])).toEqual([
      ["Narrow niche", "$5.00"],
      ["Broad", "$25"],
    ]);
    expect(roi.conclusion[0]).toContain("0.20x");
  });

  it("reads the meeting rate over the clients reporting meetings only", () => {
    const studies = nicheStudies(
      input({
        meetings: {
          brands: [
            { brandId: "b1", meetingsByMonth: { "2026-09": 4 }, spendByMonth: { "2026-09": 200 } },
            { brandId: "b9", meetingsByMonth: { "2026-09": 9 }, spendByMonth: { "2026-09": 90 } },
          ],
          outcomesRequired: 10,
          note: "rule",
        },
      }),
    );
    const m = studies.find((s) => s.id === "meeting-niche-rate")!;
    expect(m.pipe).toBeNull();
    expect(m.outcome).toBe("meeting");
    // b1 (narrow): 4 meetings over its 800 people emailed on both pipes; b9 has no grade: out
    expect(m.charts[0]!.points).toEqual([expect.objectContaining({ label: "Narrow niche", display: "0.50%", thin: true })]);
  });

  it("says so when the grades cannot be read, never a figure", () => {
    const studies = nicheStudies(input({ grades: null }));
    expect(studies).toHaveLength(4);
    expect(studies.every((s) => s.status === "not_enough_data" && s.headline === "Not readable right now.")).toBe(true);
  });
});

describe("niche grades", () => {
  it("judges an offer on its own audiences, else the brand's", () => {
    const offers = [{ offerId: "f1", name: "Billing agents", description: "AI agents for medical billing teams." }];
    const audiences = [
      { name: "Billing managers", targetText: "Billing managers at US medical practices.", offerId: "f1" },
      { name: "Other", targetText: "Anyone.", offerId: "f2" },
    ];
    const s = judgedStateOf({ name: "Daybook", domain: "daybook.health" }, "f1", offers, audiences);
    expect(s.offer).toEqual({ name: "Billing agents", description: "AI agents for medical billing teams." });
    expect(s.audiences).toEqual([{ name: "Billing managers", target: "Billing managers at US medical practices." }]);
    expect(judgedStateOf({ name: "Daybook", domain: null }, "", offers, audiences).audiences).toHaveLength(2);
  });

  it("re-asks only when the judged text changes", () => {
    const a = { brand: { name: "X", domain: "x.com" }, offer: null, audiences: [{ name: "A", target: "t" }, { name: "B", target: "u" }] };
    const b = { ...a, audiences: [...a.audiences].reverse() };
    expect(stateHashOf(a)).toBe(stateHashOf(b));
    expect(stateHashOf(a)).not.toBe(stateHashOf({ ...a, offer: { name: "o", description: null } }));
  });

  it("leaves our own brand out and asks Jev a three-grade choice", () => {
    expect(isOurDomain("distribute.you")).toBe(true);
    expect(isOurDomain("docdinners.com")).toBe(false);
    expect(isOurDomain(null)).toBe(false);
    expect(Object.keys(nicheQuestion().criteria)).toEqual(["narrow", "focused", "broad"]);
  });
});
