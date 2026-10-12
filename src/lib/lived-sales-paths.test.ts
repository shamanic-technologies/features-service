import { describe, expect, it } from "vitest";
import {
  computeLivedPaths,
  livedPathIdOf,
  livedStepsOf,
  placeOfferlessFacts,
  type Journey,
  type JourneyFact,
  type LivedPathInputs,
} from "./lived-sales-paths.js";

const STEPS = ["conversation", "website_visit", "booking_call", "meeting_booked", "meeting_attended", "signup", "form_submitted", "purchase", "paid_client", "lead_found", "industry_update_video"];

const fact = (label: string, occurredAt: string | null, extra: Partial<JourneyFact> = {}): JourneyFact => ({
  label,
  occurredAt,
  campaignId: null,
  attributable: null,
  valueCents: null,
  ...extra,
});

const inputs = (journeys: Journey[], over: Partial<LivedPathInputs> = {}): LivedPathInputs => ({
  journeys,
  costByCampaign: new Map(),
  funnelOfCampaign: new Map(),
  stepKeys: STEPS,
  lifetimeRevenueOf: () => 1000,
  ...over,
});

describe("livedPathIdOf", () => {
  it("spells a lived route the way the catalogue spells a path (served leg keys, + joined, to Paid client)", () => {
    expect(livedPathIdOf(["lead_found", "conversation"])).toBe("start_to_lead_found+lead_found_to_conversation+conversation_to_paid_client");
    expect(livedPathIdOf(["industry_update_video", "website_visit", "signup"])).toBe(
      "start_to_industry_update_video+industry_update_video_to_website_visit+website_visit_to_signup+signup_to_paid_client",
    );
  });
});

describe("livedStepsOf", () => {
  it("a person our email reached first entered at Lead found; steps ordered by date, once each; timeline words mapped", () => {
    const j: Journey = {
      leadId: "l1",
      offerId: "o1",
      acts: [{ campaignId: "c1", firstActedAt: "2026-09-01T00:00:00Z" }],
      facts: [
        fact("initial_email", "2026-09-01T00:00:00Z", { campaignId: "c1" }),
        fact("website_visit", "2026-09-03T00:00:00Z"),
        fact("interested", "2026-09-02T00:00:00Z"),
        fact("website_visit", "2026-09-05T00:00:00Z"),
        fact("opened", "2026-09-01T10:00:00Z"),
        fact("paid_client", "2026-09-10T00:00:00Z", { attributable: true }),
      ],
    };
    expect(livedStepsOf(j, STEPS)).toEqual(["lead_found", "conversation", "website_visit"]);
  });

  it("a person whose first fact is the video engagement entered at that step (any label equal to a step key is placed)", () => {
    const j: Journey = {
      leadId: "l1",
      offerId: "o1",
      acts: [{ campaignId: "social", firstActedAt: "2026-10-12T10:00:00Z" }],
      facts: [fact("industry_update_video", "2026-10-12T10:00:00Z", { campaignId: "social" }), fact("signup", "2026-10-13T00:00:00Z")],
    };
    expect(livedStepsOf(j, STEPS)).toEqual(["industry_update_video", "signup"]);
  });

  it("undated steps go last, in catalogue order", () => {
    const j: Journey = { leadId: "l", offerId: "o", acts: [], facts: [fact("meeting_booked", null), fact("signup", null), fact("conversation", "2026-01-01T00:00:00Z")] };
    expect(livedStepsOf(j, STEPS)).toEqual(["conversation", "meeting_booked", "signup"]);
  });
});

describe("placeOfferlessFacts", () => {
  it("joins a person's only offer, leaves a several-offer person's offerless facts unplaced", () => {
    const { journeys, unplacedFacts } = placeOfferlessFacts([
      { leadId: "a", offerId: "o1", facts: [fact("conversation", null)], acts: [] },
      { leadId: "a", offerId: null, facts: [fact("meeting_booked", null)], acts: [] },
      { leadId: "b", offerId: "o1", facts: [], acts: [] },
      { leadId: "b", offerId: "o2", facts: [], acts: [] },
      { leadId: "b", offerId: null, facts: [fact("meeting_booked", null), fact("signup", null)], acts: [] },
    ]);
    expect(journeys.find((j) => j.leadId === "a")!.facts.map((f) => f.label)).toEqual(["conversation", "meeting_booked"]);
    expect(journeys.filter((j) => j.leadId === "b")).toHaveLength(2);
    expect(unplacedFacts).toBe(2);
  });
});

describe("computeLivedPaths", () => {
  it("a person with two journeys on two offers counts once per offer, each on its own path", () => {
    const r = computeLivedPaths(
      inputs([
        {
          leadId: "p",
          offerId: "o1",
          acts: [{ campaignId: "c1", firstActedAt: "2026-09-01T00:00:00Z" }],
          facts: [fact("interested", "2026-09-02T00:00:00Z", { campaignId: "c1" }), fact("paid_client", "2026-09-09T00:00:00Z", { campaignId: "c1", attributable: true, valueCents: 250000 })],
        },
        {
          leadId: "p",
          offerId: "o2",
          acts: [{ campaignId: "c2", firstActedAt: "2026-09-01T00:00:00Z" }],
          facts: [fact("website_visit", "2026-09-03T00:00:00Z", { campaignId: "c2" })],
        },
      ], { costByCampaign: new Map([["c1", 100], ["c2", 50]]) }),
    );
    expect(r.totals).toMatchObject({ leads: 2, people: 1, peopleEmailed: 0 });
    expect(r.paths.map((p) => [p.pathId, p.leads, p.paidClients, p.revenueUsd, p.costUsd])).toEqual([
      ["start_to_lead_found+lead_found_to_conversation+conversation_to_paid_client", 1, 1, 2500, 100],
      ["start_to_lead_found+lead_found_to_website_visit+website_visit_to_paid_client", 1, 0, 0, 50],
    ]);
  });

  it("a path with no paid client reads learning with a null roi, never 0; measured ranks above it", () => {
    const r = computeLivedPaths(
      inputs([
        { leadId: "a", offerId: "o", acts: [{ campaignId: "c", firstActedAt: "2026-01-01T00:00:00Z" }], facts: [] },
        {
          leadId: "b",
          offerId: "o",
          acts: [{ campaignId: "c", firstActedAt: "2026-01-01T00:00:00Z" }],
          facts: [fact("conversation", "2026-01-02T00:00:00Z"), fact("paid_client", "2026-01-05T00:00:00Z", { attributable: true })],
        },
      ], { costByCampaign: new Map([["c", 200]]) }),
    );
    const [first, second] = r.paths;
    expect(first).toMatchObject({ rank: 1, status: "measured", paidClients: 1, revenueUsd: 1000, costUsd: 100, roi: 10 });
    expect(second).toMatchObject({ rank: 2, status: "learning", paidClients: 0, roi: null, costUsd: 100 });
  });

  it("Σ paths + unattributed = the whole spend; a sourcing unit spreads over its funnel; spend with no campaign is unattributed", () => {
    const funnel = { funnelCampaignId: "F", salesFunnelId: "start_to_lead_found@x+lead_found_to_conversation@y", salesFunnelName: "Joy" };
    const r = computeLivedPaths(
      inputs(
        [
          { leadId: "a", offerId: "o", acts: [{ campaignId: "out", firstActedAt: null }], facts: [] },
          { leadId: "b", offerId: "o", acts: [{ campaignId: "out", firstActedAt: null }], facts: [fact("conversation", null)] },
          { leadId: "c", offerId: "o", acts: [{ campaignId: "lonely", firstActedAt: null }], facts: [] },
        ],
        {
          costByCampaign: new Map<string | null, number>([["out", 10], ["src", 30], [null, 7], ["gone", 3], ["lonely", 1]]),
          funnelOfCampaign: new Map([["out", funnel], ["src", funnel]]),
        },
      ),
    );
    expect(r.totals.totalCostUsd).toBeCloseTo(51, 10);
    expect(r.totals.costUsd + r.totals.unattributedCostUsd).toBeCloseTo(51, 10);
    expect(r.paths.reduce((s, p) => s + p.costUsd, 0)).toBeCloseTo(r.totals.costUsd, 10);
    expect(r.totals.unattributedCost).toEqual([
      { reason: "no_campaign", campaignId: null, costUsd: 7 },
      { reason: "acted_on_nobody", campaignId: "gone", costUsd: 3 },
    ]);
    const f = r.funnels.find((g) => g.funnelCampaignId === "F")!;
    expect(f.totals.leads).toBe(2);
    expect(f.totals.costUsd).toBeCloseTo(40, 10);
    expect(r.funnels.at(-1)!.funnelCampaignId).toBeNull();
  });

  it("a paid client that is not ours is counted apart and never priced; nobody's CRM-only journey is excluded", () => {
    const r = computeLivedPaths(
      inputs([
        { leadId: "a", offerId: "o", acts: [{ campaignId: "c", firstActedAt: null }], facts: [fact("paid_client", null, { attributable: false, valueCents: 900 })] },
        { leadId: "z", offerId: null, acts: [], facts: [fact("paid_client", null, { attributable: false, valueCents: 900 })] },
      ]),
    );
    expect(r.totals).toMatchObject({ leads: 1, paidClients: 0, notOurPaidClients: 1, revenueUsd: 0, excludedJourneys: 1 });
  });

  it("an ours paid client with no amount and no lifetime revenue makes revenue unknown, never $0", () => {
    const r = computeLivedPaths(
      inputs([{ leadId: "a", offerId: "o", acts: [{ campaignId: "c", firstActedAt: null }], facts: [fact("paid_client", null, { attributable: true })] }], {
        lifetimeRevenueOf: () => null,
        costByCampaign: new Map([["c", 5]]),
      }),
    );
    expect(r.paths[0]).toMatchObject({ status: "measured", revenueUsd: null, roi: null, unavailableReason: "paid_client_unpriced" });
    expect(r.totals.revenueUsd).toBeNull();
  });
});

describe("computeLivedPaths people", () => {
  it("peopleEmailed counts distinct people with an email act, once across offers", () => {
    const r = computeLivedPaths(
      inputs([
        { leadId: "a", offerId: "o1", acts: [{ campaignId: "c", firstActedAt: null, kind: "email" }], facts: [] },
        { leadId: "a", offerId: "o2", acts: [{ campaignId: "d", firstActedAt: null, kind: "email" }], facts: [] },
        { leadId: "b", offerId: "o1", acts: [], facts: [fact("meeting_booked", null, { campaignId: "c" })] },
      ]),
    );
    expect(r.totals).toMatchObject({ leads: 3, people: 2, peopleEmailed: 1 });
  });
});
