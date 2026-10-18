import { describe, it, expect, vi } from "vitest";

vi.unmock("./fleet-positive-repliers.js");
vi.unmock("./screened-visits.js");
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { creditServingRows } from "./serving-row-credit.js";
import { matureSlugStats } from "./mature-evidence.js";
import { rollUpLegEvidenceByDynasty, legFiguresOf } from "./fleet-leg-maturity.js";
import { isScreenedVisitLeg, screenableShare, screenedCountsOfStats, screenVisitEvidence } from "./screened-visits.js";
import type { Journey } from "./lived-sales-paths.js";
import type { EnginePerson } from "./revenue-engine.js";

const { bucketPopulation } = await import("./fleet-positive-repliers.js");

/**
 * SCOUT-VISIT-SCREEN-1018 (prod 2026-10-18): Rampart read 160 website visits on the visit leg, ~26 of them clicks
 * our tracker judged human; the rest were provider-reported clicks on emails sent through Instantly, which nobody
 * can screen (mostly link scanners). A website visit is a click judged human, on the screenable sends only.
 */
function person(leadId: string, workflowSlug: string, signals: Record<string, boolean>): EnginePerson {
  return {
    leadId,
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    campaignId: "C",
    workflowSlug,
    servedAt: "2026-09-01T12:00:00.000Z",
    signals,
  };
}

const at = "2026-09-01T12:00:00Z";
const later = "2026-09-02T09:00:00Z";
const journey = (leadId: string, workflowSlug: string, screenable: boolean, click: boolean | null): Journey => ({
  leadId,
  offerId: "o",
  facts:
    click === null
      ? []
      : [{ label: "website_visit", source: "outreach", occurredAt: later, campaignId: "C", attributable: true, valueCents: null, screened: click }],
  acts: [{ campaignId: "C", firstActedAt: at, kind: "email" }],
  emailSends: [{ campaignId: "C", workflowSlug, firstSentAt: at, lastSentAt: at, screenable }],
});

// wf-a: 2 people emailed through our transport (one human click), 2 through the provider (both clicked).
// wf-b: 2 people emailed through the provider only, both clicked: no visit can be screened.
const journeys: Journey[] = [
  journey("a1", "wf-a", true, true),
  journey("a2", "wf-a", true, null),
  journey("a3", "wf-a", false, false),
  journey("a4", "wf-a", false, false),
  journey("b1", "wf-b", false, false),
  journey("b2", "wf-b", false, false),
];
const persons = creditServingRows(
  [
    person("a1", "wf-a", { contacted: true, clicked: true }),
    person("a2", "wf-a", { contacted: true }),
    person("a3", "wf-a", { contacted: true, clicked: true }),
    person("a4", "wf-a", { contacted: true, clicked: true }),
    person("b1", "wf-b", { contacted: true, clicked: true }),
    person("b2", "wf-b", { contacted: true, clicked: true }),
  ],
  journeys,
);

describe("a website visit is a click judged human, on the screenable sends only", () => {
  it("only the website-visit leg is screened", () => {
    expect(isScreenedVisitLeg("start_to_website_visit")).toBe(true);
    expect(isScreenedVisitLeg("start_to_conversation")).toBe(false);
  });

  it("a provider (unscreened) click is never a website visit; a click our tracker judged human is", () => {
    const credit = (id: string) => persons.find((p) => p.leadId === id)!.servingRowCredit!;
    expect(credit("a1")).toMatchObject({ clicked: true, humanClicked: true, screenedContacted: true });
    expect(credit("a2")).toMatchObject({ clicked: false, humanClicked: false, screenedContacted: true });
    expect(credit("a3")).toMatchObject({ clicked: true, humanClicked: false, screenedContacted: false });
    expect(credit("b1")).toMatchObject({ clicked: true, humanClicked: false, screenedContacted: false });
  });

  it("the leg evidence counts human visits over screenable contacts, and spends only the screenable share", () => {
    const stats = matureSlugStats(persons, null);
    const costGroups = [
      { dimensions: { workflowSlug: "wf-a" }, totalCostInUsdCents: "400", runCount: 4 },
      { dimensions: { workflowSlug: "wf-b" }, totalCostInUsdCents: "200", runCount: 2 },
    ];
    const screened = screenVisitEvidence(costGroups, stats, screenedCountsOfStats(stats));
    const workflows = [
      { workflowSlug: "wf-a", workflowDynastySlug: "a" },
      { workflowSlug: "wf-b", workflowDynastySlug: "b" },
    ];
    const { byDynasty } = rollUpLegEvidenceByDynasty(workflows, screened.costGroups, screened.emailStats);
    // wf-a: 1 human visit of 2 screenable contacts, on half its spend ($2): $2 per visit (was 3 clicks, $1.33).
    expect(legFiguresOf("start_to_website_visit", byDynasty.get("a"))).toMatchObject({ outcomes: 1, contacted: 2, spentUsd: 2, costPerOutcomeUsd: 2 });
    // wf-b: nothing screenable, so no website-visit evidence at all (was 2 clicks).
    expect(legFiguresOf("start_to_website_visit", byDynasty.get("b"))).toMatchObject({ outcomes: 0, contacted: 0, spentUsd: 0, costPerOutcomeUsd: null });
    // The inputs are untouched.
    expect(costGroups[0].totalCostInUsdCents).toBe("400");
    expect(stats.get("wf-a")!.recipientsClicked).toBe(3);
  });

  it("the fleet person cell carries the same screened counts", () => {
    const buckets = bucketPopulation(persons).buckets;
    expect(buckets.get("C\twf-a\t2026-09-01")).toEqual([4, 3, 0, 2, 1]);
    expect(buckets.get("C\twf-b\t2026-09-01")).toEqual([2, 2, 0, 0, 0]);
  });

  it("a slug nobody saw contacted has no screenable share", () => {
    expect(screenableShare(undefined)).toBe(0);
    expect(screenableShare({ contacted: 0, screenedContacted: 0, humanClicks: 0 })).toBe(0);
    expect(screenableShare({ contacted: 4, screenedContacted: 1, humanClicks: 0 })).toBe(0.25);
  });
});

describe("lead-service's journeys: which sends and clicks our tracker could screen", async () => {
  const { toJourney } = await import("./brand-journeys-client.js");
  it("a send through our transport is screenable, a provider one is not; a click carries its verdict", () => {
    const j = toJourney({
      leadId: "l1",
      offerId: null,
      facts: [
        { label: "website_visit", source: "outreach", occurredAt: later, campaignId: "C", screened: true, transport: "smtp" },
        { label: "website_visit", source: "outreach", occurredAt: later, campaignId: "C", screened: false, transport: "instantly" },
        { label: "initial_email", source: "outreach", occurredAt: at, campaignId: "C", screened: null, transport: "smtp" },
      ],
      acts: [],
      emailSends: [
        { campaignId: "C", workflowSlug: "w", firstSentAt: at, lastSentAt: at, transports: [{ transport: "smtp" }] },
        { campaignId: "D", workflowSlug: "w", firstSentAt: at, lastSentAt: at, transports: [{ transport: "instantly" }] },
        { campaignId: "E", workflowSlug: "w", firstSentAt: at, lastSentAt: at },
      ],
    } as never);
    expect(j.facts.map((f) => f.screened)).toEqual([true, false, undefined]);
    expect(j.emailSends!.map((e) => e.screenable)).toEqual([true, false, undefined]);
  });
});
