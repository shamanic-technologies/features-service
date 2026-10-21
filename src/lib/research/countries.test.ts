import { describe, it, expect, vi } from "vitest";

vi.unmock("../fleet-positive-repliers.js");
vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));

import { countryMeetingStudy, countryStudies, countryLabel } from "./countries.js";
import type { SlugCell } from "./buckets.js";
import type { PipeTerms } from "./studies.js";
import type { FleetPersonBucket } from "../fleet-positive-repliers.js";
import type { EnginePerson } from "../revenue-engine.js";

const { bucketPopulation, encodeCell, decodeCell } = await import("../fleet-positive-repliers.js");

/**
 * RESEARCH-COUNTRY-1021: the owner tells clients "the US is the market where cold email works best". Per prospect
 * country (the person's own), the cold email outcomes, each with its sample and the page's maturity / noise status.
 */
const terms: PipeTerms = {
  pipe: "cold-email-positive-reply",
  noun: "positive reply",
  nounPlural: "positive replies",
  exposureNoun: "people emailed",
  exposureNounOne: "person emailed",
  outcomesRequired: 1,
  partialMonth: null,
  note: "Rule note.",
};

const person = (org: string, country: string | null, contacted: number, replies: number): FleetPersonBucket => ({
  orgId: org,
  brandId: "b1",
  campaignId: "c1",
  workflowSlug: "wf-v1",
  servedDay: "2026-08-10",
  contacted,
  clicked: 0,
  positiveReplies: replies,
  screenedContacted: 0,
  humanClicked: 0,
  generation: null,
  country,
});

const half = (spentUsd: number, contacted: number, outcomes: number) => ({ figures: { spentUsd, contacted, outcomes }, months: { "2026-08": { spentUsd, contacted: 0, outcomes: 0 } }, strata: { "o1|2026-08": { spentUsd, contacted: 0, outcomes: 0 } } });

function build(persons: FleetPersonBucket[], excluded: string[] = []) {
  const contacted = persons.reduce((a, p) => a + p.contacted, 0);
  const outcomes = persons.reduce((a, p) => a + p.positiveReplies, 0);
  const cells: SlugCell[] = [{ slug: "wf-v1", flash: half(contacted / 10, contacted, outcomes), mature: half(contacted / 10, contacted, outcomes) }];
  return countryStudies({ terms, legKey: "start_to_conversation", cells, persons, split: { screened: false, signal: "positiveReply", cutoffDay: "2026-09-30" }, excludedOrgIds: new Set(excluded) });
}

describe("country studies", () => {
  it("a country with 3 sends and 1 reply is drawn, faded, never the winner", () => {
    const [rate] = build([person("o1", "United States", 2000, 40), person("o1", "France", 1000, 10), person("o1", "Malta", 3, 1)]);
    expect(rate!.id).toBe("cold-email-positive-reply-country-rate");
    expect(rate!.topic).toBe("country");
    expect(rate!.winner).toBe("United States");
    const malta = rate!.charts[0]!.points.find((p) => p.label === "Malta")!;
    expect(malta.display).toBe("33.33%");
    expect(malta.thin).toBe(true);
    expect(malta.note).toContain("under 5 positive replies");
    expect(rate!.charts[0]!.points[0]!.label).toBe("Malta"); // drawn where its value puts it
  });

  it("states whether the US is the best market, by how much, on the verdict rule", () => {
    const [rate, roi] = build([person("o1", "United States", 2000, 40), person("o1", "France", 1000, 10)]);
    const us = rate!.conclusion[0]!;
    expect(us).toMatch(/^Is the United States the best market\? Not proven: the United States is ahead of every other country together, but the gap is noise so far\./);
    expect(us).toContain("United States: 2.00% (40 positive replies · 2,000 people emailed, mature)");
    expect(us).toContain("2.00x the positive reply rate of every other country together: 1.00% (10 positive replies · 1,000 people emailed)");
    // spend shares out on people: same price per person, so the US reply is half the price
    expect(roi!.winner).toBe("United States");
    expect(roi!.conclusion[0]).toContain("costs 0.50x what it costs in every other country together");
  });

  it("Yes only on a conclusion, never because the US is the only country big enough to judge", () => {
    const [yes] = build([person("o1", "United States", 20000, 400), person("o1", "France", 10000, 50)]);
    expect(yes!.verdict.kind).toBe("conclusion");
    expect(yes!.conclusion[0]).toMatch(/^Is the United States the best market\? Yes\./);
    // prod 2026-10-21, website visits: the US alone reaches the bar, and does WORSE than the rest together
    const [behind] = build([person("o1", "United States", 1532, 18), ...["Austria", "Belgium", "India", "United Kingdom"].map((c) => person("o1", c, 155, 2)), person("o1", "Canada", 0, 1)]);
    expect(behind!.winner).toBe("United States");
    expect(behind!.conclusion[0]).toMatch(/^Is the United States the best market\? Not proven: the United States is behind every other country together, but the gap is noise so far\./);
    expect(behind!.verdict.reason).toContain("against Every other country");
  });

  it("says No when another country with enough replies beats the US", () => {
    const [rate] = build([person("o1", "United States", 2000, 20), person("o1", "Germany", 500, 20)]);
    expect(rate!.winner).toBe("Germany");
    expect(rate!.conclusion[0]).toMatch(/^Is the United States the best market\? No: Germany beats it/);
  });

  it("leaves out our own orgs and people with no country, and says so", () => {
    const [rate] = build([person("o1", "United States", 2000, 40), person("staff", "France", 500, 50), person("o1", null, 300, 1), person("o1", "France", 1000, 10)], ["staff"]);
    const fr = rate!.charts[0]!.points.find((p) => p.label === "France")!;
    expect(fr.note).toContain("1,000 people emailed");
    expect(rate!.conclusion.join(" ")).toContain("300 people emailed whose country is not on record are left out.");
    expect(rate!.conclusion.join(" ")).toContain("Our own and staff test accounts are left out (500 people emailed).");
  });

  it("no country reaching the bar = no winner", () => {
    const [rate] = build([person("o1", "United States", 20, 2), person("o1", "France", 10, 1)]);
    expect(rate!.winner).toBeNull();
    expect(rate!.status).toBe("not_enough_data");
  });

  it("every US spelling is one country", () => {
    expect(countryLabel("USA")).toBe("United States");
    expect(countryLabel(" united states ")).toBe("United States");
    expect(countryLabel("France")).toBe("France");
  });
});

describe("country meeting study", () => {
  const replier = (lead: string, country: string | null, brandId = "b1", orgId = "o1") => ({ orgId, brandId, leadId: lead, country });
  it("of the people who replied positively on brands reporting meetings, the share who booked, per country", () => {
    const repliers = [
      ...Array.from({ length: 20 }, (_, i) => replier(`us${i}`, "United States")),
      ...Array.from({ length: 10 }, (_, i) => replier(`fr${i}`, "France")),
      replier("x", "United States", "silent-brand"),
      replier("s", "United States", "b1", "staff"),
    ];
    const booked = new Set([...Array.from({ length: 6 }, (_, i) => `o1|b1|us${i}`), "o1|b1|fr0", "o1|silent-brand|x", "staff|b1|s"]);
    const s = countryMeetingStudy({ repliers, reportingBrandIds: new Set(["b1"]), booked, excludedOrgIds: new Set(["staff"]) });
    expect(s.id).toBe("meeting-country-rate");
    expect(s.outcome).toBe("meeting");
    expect(s.winner).toBe("United States");
    expect(s.charts[0]!.points.map((p) => [p.label, p.display, p.thin])).toEqual([
      ["United States", "30%", false],
      ["France", "10%", true],
    ]);
    expect(s.conclusion[0]).toContain("United States 30% (6 meetings of 20 people) against every other country together 10% (1 meeting of 10 people)");
  });

  it("unreadable attribution = not readable, never zero", () => {
    const s = countryMeetingStudy({ repliers: [], reportingBrandIds: null, booked: new Set(), excludedOrgIds: new Set() });
    expect(s.status).toBe("not_enough_data");
    expect(s.headline).toBe("Not readable right now.");
  });
});

describe("the fleet person cell files each person under their own country", () => {
  const p = (leadId: string, country: string | null | undefined, replied: boolean): EnginePerson =>
    ({
      leadId,
      campaignId: "C",
      workflowSlug: "wf",
      servedAt: "2026-09-01T00:00:00Z",
      ...(country !== undefined ? { leadCountry: country } : {}),
      signals: { contacted: true, positiveReply: replied },
    }) as unknown as EnginePerson;

  it("a fifth key part when known, the old three-part key when not", () => {
    const pop = bucketPopulation([p("a", "France", true), p("b", null, false), p("c", undefined, false)]);
    expect([...pop.buckets.keys()].sort()).toEqual(["C\twf\t2026-09-01", "C\twf\t2026-09-01\t\tFrance"]);
    expect([...pop.repliers!]).toEqual([["a", "France"]]);
  });

  it("the repliers survive the store, and a cell stored before them reads none", () => {
    const pop = bucketPopulation([p("a", "France", true)]);
    const cell = { byPair: new Map([["o:b", pop]]), computedAt: 1 };
    expect([...decodeCell(encodeCell(cell)).byPair.get("o:b")!.repliers!]).toEqual([["a", "France"]]);
    const old = JSON.stringify({ computedAt: 1, byPair: [["o:b", true, [["C\twf\t2026-09-01", [1, 0, 0, 0, 0]]]]] });
    expect(decodeCell(old).byPair.get("o:b")!.repliers).toBeUndefined();
  });
});
