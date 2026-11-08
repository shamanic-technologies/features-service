import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { chartPersonsOf, expectedConversionOf, expectedCostAndReturnOf } from "./spend-charts-io.js";
import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";
import { campaignTargetOf, groupTargetOf, unitsInPathOrder } from "../routes/spend-charts.js";
import type { EnginePerson } from "./revenue-engine.js";
import type { SalesFunnelUnitRow } from "./sales-funnel-campaigns-client.js";

const p = (leadId: string, campaignId: string, signals: Record<string, boolean>, dates: Record<string, string | null>, servedAt?: string): EnginePerson =>
  ({ leadId, campaignId, signals, signalDates: dates, servedAt } as unknown as EnginePerson);

describe("spend charts: who enters and converts on a leg (one rule, every channel)", () => {
  const coldEmail = { channelSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation", fromStep: "lead_found", toStep: "conversation" };

  it("entry leg: enters on the first message, converts on the positive reply, of the people its campaign served", () => {
    const out = chartPersonsOf(
      coldEmail,
      [
        p("a", "u1", { contacted: true, positiveReply: true }, { contacted: "2026-10-01T09:00:00Z", positiveReply: "2026-10-06T10:00:00Z" }),
        p("b", "u1", { contacted: false }, {}),
        p("c", "other", { contacted: true, positiveReply: true }, { contacted: "2026-10-01T09:00:00Z", positiveReply: "2026-10-02T10:00:00Z" }),
      ],
      new Set(["a", "b"]),
      new Map(),
    );
    expect(out).toEqual([
      { entered: true, enteredOn: "2026-10-01", converted: true, convertedOn: "2026-10-06" },
      { entered: false, enteredOn: null, converted: false, convertedOn: null },
    ]);
  });

  it("a re-contacted prospect enters on this scope's own day, and an outcome from before the scope is not its", () => {
    const out = chartPersonsOf(
      coldEmail,
      [
        // First emailed in April by another campaign, replied then; served by this scope (started Oct 16) in October.
        p("a", "u1", { contacted: true, positiveReply: true }, { contacted: "2026-04-24T09:00:00Z", positiveReply: "2026-04-30T10:00:00Z" }, "2026-10-16T08:00:00Z"),
        // Emailed by this scope Oct 16, replied Oct 18, RE-served Oct 19 (servedAt is the latest serve): still its reply.
        p("b", "u1", { contacted: true, positiveReply: true }, { contacted: "2026-10-16T09:00:00Z", positiveReply: "2026-10-18T10:00:00Z" }, "2026-10-19T08:00:00Z"),
      ],
      new Set(["a", "b"]),
      new Map(),
      "2026-10-16",
    );
    expect(out).toEqual([
      { entered: true, enteredOn: "2026-10-16", converted: false, convertedOn: null },
      { entered: true, enteredOn: "2026-10-16", converted: true, convertedOn: "2026-10-18" },
    ]);
  });

  it("a leg from a later step: the people its unit was HANDED, entering the day they were handed", () => {
    const meeting = { channelSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked", fromStep: "conversation", toStep: "meeting_booked" };
    const out = chartPersonsOf(
      meeting,
      [p("a", "u1", { positiveReply: true, meeting: true }, { positiveReply: "2026-10-01T00:00:00Z", meeting: "2026-10-04T00:00:00Z" })],
      new Set<string>(),
      new Map([["a", { claimedAt: "2026-10-02T00:00:00Z", actedAt: "2026-10-02T01:00:00Z", acted: true }]]),
    );
    expect(out).toEqual([{ entered: true, enteredOn: "2026-10-02", converted: true, convertedOn: "2026-10-04" }]);
  });

  it("a leg that finds people: nobody enters, every served person is an outcome on its serve day", () => {
    const out = chartPersonsOf(
      { fromStep: null, toStep: "lead_found" },
      [p("a", "u1", {}, {}, "2026-10-03T00:00:00Z")],
      new Set(["a"]),
      new Map(),
    );
    expect(out).toEqual([{ entered: false, enteredOn: null, converted: true, convertedOn: "2026-10-03" }]);
    expect(expectedConversionOf({ channelSlug: "lead-sourcing", legKey: "start_to_lead_found", fromStep: null, toStep: "lead_found" }, new Map(), null).conversionUnavailableReason).toBe(
      "no_entry_population",
    );
  });

  it("expected conversion of an entry leg: the fleet's, else the seeded entry default", () => {
    expect(expectedConversionOf(coldEmail, new Map([["start_to_conversation|sales-cold-email-outreach", 0.8]]), null).conversionRatePct).toBe(0.8);
    const fallback = expectedConversionOf(coldEmail, new Map(), null);
    expect(fallback.conversionRatePct).toBe(1);
    expect(fallback.conversionBasis).toBe("default");
  });

  it("expected cost per outcome only when the model prices THIS chart's step", () => {
    const expected = {
      roiMultiple: 3,
      basis: "fleet" as const,
      assumptions: [],
      combinationKey: "x",
      costPerOutcome: { costPerOutcomeUsd: 12, legKey: "start_to_conversation", stepKey: "conversation", basis: "fleet" as const, source: "fleet_measured" as const },
      unavailableReason: null,
    };
    expect(expectedCostAndReturnOf(expected, "conversation").costPerOutcomeUsd).toBe(12);
    const other = expectedCostAndReturnOf(expected, "website_visit");
    expect(other.costPerOutcomeUsd).toBeNull();
    expect(other.costPerOutcomeUnavailableReason).toBe("expected_prices_another_step");
    expect(other).not.toHaveProperty("roiMultiple");
  });
});

describe("spend charts: a campaign's pipes in path order", () => {
  const unit = (campaignId: string, pipeId: string): SalesFunnelUnitRow => ({ campaignId, pipeId, featureSlug: pipeId.split("|")[0], legKey: pipeId.split("|")[1], status: "ongoing" });
  const steps = new Map([
    ["your-team-reply-closing|conversation_to_paid_client", { fromStep: "conversation", toStep: "paid_client" }],
    ["lead-sourcing|start_to_lead_found", { fromStep: null, toStep: "lead_found" }],
    ["sales-cold-email-outreach|lead_found_to_conversation", { fromStep: "lead_found", toStep: "conversation" }],
  ]);
  const units = [
    unit("c", "your-team-reply-closing|conversation_to_paid_client"),
    unit("a", "lead-sourcing|start_to_lead_found"),
    unit("b", "sales-cold-email-outreach|lead_found_to_conversation"),
  ];

  it("orders Start first, then each step's next pipe", () => {
    expect(unitsInPathOrder(units, steps).map((u) => u.campaignId)).toEqual(["a", "b", "c"]);
  });

  // SPEND-CHART-TARGET-1108: the chart counts the campaign's TARGET, never a pipe's step.
  const campaign = (over: Partial<SalesFunnelCampaignRow> = {}): SalesFunnelCampaignRow => ({
    id: "sfc",
    brandId: "b",
    offerId: "o",
    salesFunnelId: "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
    salesFunnelName: "Wide Email",
    status: "ongoing",
    stopReason: null,
    createdAt: "2026-10-27T00:00:00Z",
    units,
    ...over,
  });
  const pathOf = () => ({ legs: [{ toStep: "lead_found" }, { toStep: "conversation" }, { toStep: "paid_client" }] });

  it("Target Paid client: charts Paid client, counted from Lead found (Wide Email, prod 2026-11-08)", () => {
    expect(campaignTargetOf(campaign({ target: "paid_client" }), steps, pathOf)).toEqual({ step: "paid_client", fromStep: "lead_found", source: "campaign_target" });
  });

  it("Target Positive reply: still charts Positive reply", () => {
    expect(campaignTargetOf(campaign({ target: "conversation" }), steps, pathOf)).toEqual({ step: "conversation", fromStep: "lead_found", source: "campaign_target" });
  });

  it("no Target stated: the last step of the funnel it runs, never the first pipe past sourcing", () => {
    expect(campaignTargetOf(campaign({ target: null }), steps, pathOf)).toEqual({ step: "paid_client", fromStep: "lead_found", source: "funnel_last_step" });
  });

  it("a Target off the units chain is still the Target (appended to the chain)", () => {
    expect(campaignTargetOf(campaign({ target: "meeting_booked" }), steps, pathOf)?.step).toBe("meeting_booked");
  });

  it("a reactive campaign counts from its trigger step", () => {
    const meeting = [unit("m", "ai-meeting-booking|conversation_to_meeting_booked")];
    const s = new Map([["ai-meeting-booking|conversation_to_meeting_booked", { fromStep: "conversation", toStep: "meeting_booked" }]]);
    expect(campaignTargetOf(campaign({ target: "meeting_booked", units: meeting }), s, () => null)).toEqual({ step: "meeting_booked", fromStep: "conversation", source: "campaign_target" });
  });

  it("an offer charts the Target most of its LIVE campaigns state, never the pipe most of them lead with", () => {
    const rows = [
      campaign({ id: "1", target: "paid_client" }),
      campaign({ id: "2", target: "meeting_booked", status: "stopped", createdAt: "2026-11-01T00:00:00Z" }),
      campaign({ id: "3", target: "meeting_booked", status: "stopped", createdAt: "2026-11-02T00:00:00Z" }),
    ];
    expect(groupTargetOf(rows, steps, pathOf)?.step).toBe("paid_client");
    // None live: most campaigns; ties to the most recent one.
    expect(groupTargetOf(rows.map((r) => ({ ...r, status: "stopped" })), steps, pathOf)?.step).toBe("meeting_booked");
    expect(groupTargetOf([campaign({ id: "a", target: "paid_client", createdAt: "2026-11-03T00:00:00Z" }), campaign({ id: "b", target: "conversation" })], steps, pathOf)?.step).toBe("paid_client");
  });
});
