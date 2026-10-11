import { describe, it, expect } from "vitest";
import { earliestOutcomeByLead, internalPipeWork, proactiveFunnelSteps, reactiveFunnelSteps } from "./funnel-campaign-activity.js";

const PROACTIVE_PATH = [
  { key: "lead_found", label: "Lead found" },
  { key: "conversation", label: "Positive reply" },
  { key: "meeting_booked", label: "Meeting booked" },
  { key: "meeting_attended", label: "Meeting attended" },
  { key: "paid_client", label: "Paid client" },
];

describe("proactiveFunnelSteps", () => {
  it("reads every step off the outreach unit's lead-service counts, Contacted and Delivered after Lead found, rates served", () => {
    const steps = proactiveFunnelSteps(PROACTIVE_PATH, {
      total: 226,
      counts: { contacted: 223, positive_reply: 4, website_visit: 1, meeting_booked: 2, meeting_attended: 1, sale: 0 },
      people: { delivered: 180 },
    });
    expect(steps.map((s) => [s.key, s.kind, s.people, s.rateToNextPct])).toEqual([
      ["lead_found", "step", 226, 98.67],
      ["contacted", "outreach", 223, 80.72],
      ["delivered", "outreach", 180, 2.22],
      ["conversation", "step", 4, 50],
      ["meeting_booked", "step", 2, 50],
      ["meeting_attended", "step", 1, 0],
      ["paid_client", "step", 0, null],
    ]);
  });

  it("a zero step has no rate to the next (never a division by zero), and an uncounted step is null with a reason", () => {
    const steps = proactiveFunnelSteps([{ key: "lead_found", label: "Lead found" }, { key: "mystery", label: "Mystery" }], {
      total: 0,
      counts: { contacted: 0 },
      people: { delivered: 0 },
    });
    expect(steps[0].rateToNextPct).toBeNull();
    expect(steps[3]).toMatchObject({ key: "mystery", people: null, unmeasuredReason: "step_not_counted", rateToNextPct: null });
    expect(steps[2].rateToNextPct).toBeNull();
  });
});

describe("reactiveFunnelSteps", () => {
  it("first step = people handed; an act step = people acted on; later steps = handed people with the outcome", () => {
    const path = [
      { key: "conversation", label: "Positive reply" },
      { key: "booking_call", label: "Booking call" },
      { key: "meeting_booked", label: "Meeting booked" },
      { key: "paid_client", label: "Paid client" },
    ];
    const steps = reactiveFunnelSteps(
      path,
      new Set(["a", "b", "c", "d"]),
      new Map([["booking_call", new Set(["a", "b"])]]),
      new Map<string, Set<string> | null>([
        ["meeting_booked", new Set(["a", "z"])],
        ["paid_client", null],
      ]),
    );
    expect(steps.map((s) => [s.key, s.people, s.rateToNextPct, s.unmeasuredReason])).toEqual([
      ["conversation", 4, 50, null],
      ["booking_call", 2, 50, null],
      ["meeting_booked", 1, null, null],
      ["paid_client", null, null, "outcomes_unreadable"],
    ]);
  });
});

describe("internalPipeWork", () => {
  it("counts each person once, on the day first handed / first acted, and reached by the outcome date", () => {
    const w = internalPipeWork(
      "meeting_booked",
      [
        { leadId: "a", firstClaimedAt: "2026-10-01T10:00:00Z", firstActedAt: "2026-10-01T11:00:00Z", actedCount: 2 },
        { leadId: "b", firstClaimedAt: "2026-10-02T10:00:00Z", firstActedAt: null, actedCount: 0 },
        { leadId: "c", firstClaimedAt: null, firstActedAt: null, actedCount: 1 },
      ],
      new Map([
        ["a", "2026-10-03T09:00:00Z"],
        ["x", "2026-10-03T09:00:00Z"],
      ]),
    );
    expect(w).toEqual({
      handed: 3,
      actedOn: 2,
      reached: 1,
      conversionRatePct: 33.33,
      daily: [
        { date: "2026-10-01", handed: 1, actedOn: 1, reached: 0 },
        { date: "2026-10-02", handed: 1, actedOn: 0, reached: 0 },
        { date: "2026-10-03", handed: 0, actedOn: 0, reached: 1 },
      ],
      undated: { handed: 1, actedOn: 1, reached: 0 },
    });
  });

  it("on a call step the act IS the outcome; with no reading of the to step, reached is null (never 0)", () => {
    const rows = [{ leadId: "a", firstClaimedAt: "2026-10-07T10:00:00Z", firstActedAt: "2026-10-07T10:01:00Z", actedCount: 1 }];
    expect(internalPipeWork("booking_call", rows, null)).toMatchObject({ reached: 1, conversionRatePct: 100 });
    expect(internalPipeWork("website_visit", rows, null)).toMatchObject({ reached: null, conversionRatePct: null });
    expect(internalPipeWork("meeting_booked", [], new Map())).toMatchObject({ handed: 0, reached: 0, conversionRatePct: null, daily: [] });
  });
});

describe("earliestOutcomeByLead", () => {
  it("keeps the earliest dated outcome per lead, null only when every one is undated", () => {
    const m = earliestOutcomeByLead([
      { leadId: "a", occurredAt: "2026-10-05T00:00:00Z" },
      { leadId: "a", occurredAt: "2026-10-02T00:00:00Z" },
      { leadId: "b", occurredAt: null },
      { leadId: "c", occurredAt: null },
      { leadId: "c", occurredAt: "2026-10-04T00:00:00Z" },
    ]);
    expect([...m]).toEqual([
      ["a", "2026-10-02T00:00:00Z"],
      ["b", null],
      ["c", "2026-10-04T00:00:00Z"],
    ]);
  });
});
