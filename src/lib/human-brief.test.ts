import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { robotBriefSplit, composeHumanBrief, cleanHumanBrief, humanBriefPrompt, briefChannelsOf, humanBriefInputOf } = await import("./human-brief.js");
const { buildCatalogueModel } = await import("./agent-catalogue.js");
const { buildChannelCatalogue } = await import("./channel-catalogue.js");
const { SEED_FEATURES } = await import("../seed/features.js");
const { servedLegKeyOf } = await import("./funnel-legs.js");

// HUMAN-BRIEF-1121 (owner 2026-11-21): « "Goal: Paid client for <offer>. Use only these channels: …" → c'est horrible et
// inutile ». A brief is one or two plain sentences; only the robot lines our system wrote are ever replaced.

const LABELS = new Set(["Paid client", "Meeting booked", "Positive reply"]);

describe("robotBriefSplit: only the robot lines our system wrote", () => {
  it("this service's old prefill, whole", () => {
    const brief = "Use only these channels:\nUse Lead Sourcing (Start to Lead): Any contact. Everyone in the audience.\nUse Sales Cold Email Outreach (Lead to Positive reply).";
    expect(robotBriefSplit(brief, LABELS)).toEqual({ shape: "features_prefill", robot: brief, rest: "" });
  });

  it("campaign-service's old birth composer, with a person's text after it kept word for word", () => {
    const brief = "Goal: Paid client for Operations Intelligence.\nUse only these channels: Lead Sourcing, Sales Cold Email Outreach.\n\nCold email pitching the offer only.";
    expect(robotBriefSplit(brief, LABELS)).toEqual({
      shape: "campaign_service_birth",
      robot: "Goal: Paid client for Operations Intelligence.\nUse only these channels: Lead Sourcing, Sales Cold Email Outreach.",
      rest: "Cold email pitching the offer only.",
    });
  });

  it("a person's brief that starts with « Goal: » in their own words is not ours", () => {
    expect(robotBriefSplit("Goal: earn the trust of founders who run a small B2B service business alone.\n\nThe first email offers an introduction.", LABELS)).toBeNull();
  });

  it("a plain human brief is not robot", () => {
    expect(robotBriefSplit("Book meetings with HR leaders at mid-size companies by cold email.", LABELS)).toBeNull();
    expect(robotBriefSplit(null, LABELS)).toBeNull();
  });
});

describe("the human brief's shape", () => {
  it("never a robot list: no « Use only these channels », no newline list, no dash", () => {
    const out = composeHumanBrief("Book meetings with HR leaders — by cold email.\nOnly confirmed addresses.", "");
    expect(out).toBe("Book meetings with HR leaders, by cold email. Only confirmed addresses.");
    expect(out).not.toContain("Use only these channels");
    expect(out).not.toContain("\n");
  });

  it("strips quotes the writer wrapped it in", () => {
    expect(cleanHumanBrief('"Win clients by cold email."')).toBe("Win clients by cold email.");
  });

  it("keeps a person's appended text after the human sentence", () => {
    expect(composeHumanBrief("Win clients for SaaS Video Production by cold email.", "Cold email pitching the offer only.")).toBe("Win clients for SaaS Video Production by cold email.\n\nCold email pitching the offer only.");
  });

  it("the writer is told the owner's rules and never sees a channel list format to copy", () => {
    const { systemPrompt, message } = humanBriefPrompt({
      offer: { name: "Payroll audit", description: "We find payroll errors." },
      audiences: ["HR leaders at mid-size companies"],
      targetLabel: "Meeting booked",
      channels: [
        { name: "Lead Sourcing", fromLabel: "Start", toLabel: "Lead found", ownTeam: false, play: null },
        { name: "Sales Cold Email Outreach", fromLabel: "Lead found", toLabel: "Positive reply", ownTeam: false, play: { name: "Valid only", description: "Sends only to confirmed addresses." } },
        { name: "Your Team Reply Closing", fromLabel: "Positive reply", toLabel: "Paid client", ownTeam: true, play: null },
      ],
      replacing: null,
    });
    expect(systemPrompt).toContain("one or two short sentences");
    expect(systemPrompt).toContain("by cold email");
    expect(message).toContain("Payroll audit");
    expect(message).toContain("HR leaders at mid-size companies");
    expect(message).toContain("Sends only to confirmed addresses.");
    expect(message).not.toContain("Your Team Reply Closing");
    expect(message).not.toContain("Use only these channels");
  });
});

describe("the channels the client chose, from the catalogue", () => {
  const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
  const model = buildCatalogueModel({
    channels,
    publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
    declaredSteps: [],
    measurements: new Map(),
    lifetimeRevenueUsd: 3000,
  });
  const FUNNEL = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";

  it("names each pipe of the funnel in order, the client's own team marked", () => {
    const out = briefChannelsOf(model, FUNNEL);
    expect(out.map((c) => c.name).slice(0, 2)).toEqual(["Lead Sourcing", "Sales Cold Email Outreach"]);
    expect(out.every((c) => c.play === null)).toBe(true);
  });

  it("an onboarding card with no funnel says the aim only", () => {
    const input = humanBriefInputOf(model, { offer: { name: "O", description: null }, audiences: [] }, { salesFunnelId: null, target: "paid_client", replacing: null });
    expect(input.channels).toEqual([]);
    expect(input.targetLabel).toBe("Paid client");
  });
});
