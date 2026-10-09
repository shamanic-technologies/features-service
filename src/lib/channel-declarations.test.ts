import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  checkLegRun,
  DeclarationError,
  legPricingOf,
  mergeDeclarations,
  parseChannelInput,
  parseLegInput,
  parseSalesPathInput,
  parseTriggerInput,
  type DeclaredChannel,
  type DeclaredLeg,
  type TriggerTypeRecord,
} from "./channel-declarations.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { channelShortDescription } from "./channel-short-descriptions.js";
import { channelTypeOf } from "./channel-types.js";
import { combinationKeyOf } from "./offer-sales-paths.js";
import { CHANNEL_TRIGGER_TYPES } from "./channel-triggers.js";
import { SEED_FEATURES } from "../seed/features.js";

const NOW = "2026-10-09T00:00:00.000Z";
const SEEDED = SEED_FEATURES.filter((f) => f.status === "active");

const codeTriggers: TriggerTypeRecord[] = CHANNEL_TRIGGER_TYPES.map((t, i) => ({
  ...t,
  origin: "code",
  kind: "event",
  params: null,
  displayOrder: i,
  createdBy: null,
  requestedByOrgId: null,
}));
const delayTrigger: TriggerTypeRecord = {
  id: "no_reply_after_3_days",
  label: "No reply in 3 days",
  description: "Three days after the first email, nobody replied.",
  icon: "clock",
  fromStep: "lead_found",
  firedBy: "campaign-service",
  coded: false,
  origin: "declared",
  kind: "delay",
  params: { afterStep: "lead_found", days: 3 },
  displayOrder: 7,
  createdBy: "kevin",
  requestedByOrgId: null,
};
const TRIGGERS = [...codeTriggers, delayTrigger];

const channelBody = {
  slug: "whatsapp-concierge",
  name: "WhatsApp Concierge",
  description: "A person answers every interested buyer on WhatsApp.",
  shortDescription: "Answers buyers on WhatsApp",
  icon: "whatsapp-logo",
  channelType: "conversion",
  operatedBy: "platform",
  performedBy: "person",
  dailyOperatingCostCents: 0,
  minimumCommitmentDays: 30,
  maxDaysToFirstProduction: 3,
};

const declaredChannel = (over: Partial<DeclaredChannel> = {}): DeclaredChannel => ({
  ...(channelBody as Omit<DeclaredChannel, "displayOrder" | "published" | "publishedAt" | "publishedBy" | "createdBy" | "requestedByOrgId" | "createdAt" | "updatedAt">),
  channelType: "conversion",
  operatedBy: "platform",
  performedBy: "person",
  displayOrder: 10_000,
  published: false,
  publishedAt: null,
  publishedBy: null,
  createdBy: "kevin",
  requestedByOrgId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const declaredLeg = (over: Partial<DeclaredLeg> = {}): DeclaredLeg => ({
  channelSlug: "whatsapp-concierge",
  legKey: "conversation_to_meeting_booked",
  fromStep: "conversation",
  toStep: "meeting_booked",
  mode: "reactive",
  triggerId: "positive_reply_received",
  published: false,
  createdBy: "kevin",
  requestedByOrgId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const refused = (fn: () => unknown, status: number, reason: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DeclarationError);
    expect({ status: (err as DeclarationError).status, reason: (err as DeclarationError).reason }).toEqual({ status, reason });
    return;
  }
  throw new Error(`expected ${reason}`);
};

const build = (channels: DeclaredChannel[], legs: DeclaredLeg[], publishedOnly: boolean) => {
  const m = mergeDeclarations(SEEDED, { channels, legs, triggers: TRIGGERS }, { publishedOnly }, { shortDescriptionOf: channelShortDescription, channelTypeOfSlug: channelTypeOf });
  return buildChannelCatalogue(m.rows, m.shortDescriptionOf, m.channelTypeOfSlug, m.triggerOf);
};

describe("a leg can only name a trigger something FIRES, checked at creation (owner 2026-10-09)", () => {
  const channel = { slug: "whatsapp-concierge", managed: false, legKeys: new Set<string>() };

  it("refuses a reactive leg on a trigger nothing fires, with a named 409", () => {
    // `meeting_booked` is coded in the list but no service fires it yet.
    refused(() => parseLegInput({ fromStep: "meeting_booked", toStep: "meeting_attended", mode: "reactive", triggerId: "meeting_booked" }, channel, TRIGGERS), 409, "trigger_not_fired");
    // A declared EVENT trigger: no generic detector can fire an arbitrary event.
    const declaredEvent: TriggerTypeRecord = { ...delayTrigger, id: "invoice_paid", kind: "event", params: null, fromStep: null };
    refused(() => parseLegInput({ fromStep: "lead_found", toStep: "conversation", mode: "reactive", triggerId: "invoice_paid" }, channel, [...TRIGGERS, declaredEvent]), 409, "trigger_not_fired");
  });

  it("accepts a reactive leg on a declared delay or poll trigger: campaign-service fires both kinds (#601)", () => {
    expect(parseLegInput({ fromStep: "lead_found", toStep: "conversation", mode: "reactive", triggerId: "no_reply_after_3_days" }, channel, TRIGGERS).triggerId).toBe("no_reply_after_3_days");
    const poll: TriggerTypeRecord = { ...delayTrigger, id: "new_job_post", kind: "poll", fromStep: null, params: { source: "{}", everyMinutes: 60 } };
    expect(parseLegInput({ fromStep: null, toStep: "lead_found", mode: "reactive", triggerId: "new_job_post" }, channel, [...TRIGGERS, poll]).triggerId).toBe("new_job_post");
  });

  it("accepts a reactive leg on a coded trigger", () => {
    expect(parseLegInput({ fromStep: "conversation", toStep: "meeting_booked", mode: "reactive", triggerId: "positive_reply_received" }, channel, TRIGGERS)).toEqual({
      legKey: "conversation_to_meeting_booked",
      fromStep: "conversation",
      toStep: "meeting_booked",
      mode: "reactive",
      triggerId: "positive_reply_received",
    });
  });

  it("refuses an unknown trigger, a reactive leg with none, a proactive leg with one", () => {
    refused(() => checkLegRun("reactive", "nope", TRIGGERS), 404, "trigger_not_found");
    refused(() => checkLegRun("reactive", null, TRIGGERS), 400, "trigger_required");
    refused(() => checkLegRun("proactive", "lead_requested", TRIGGERS), 400, "proactive_leg_has_trigger");
    expect(checkLegRun("proactive", undefined, TRIGGERS)).toEqual({ mode: "proactive", triggerId: null });
  });

  it("refuses a leg the channel already performs, an absent from step, a leg going nowhere", () => {
    refused(() => parseLegInput({ fromStep: "conversation", toStep: "meeting_booked", mode: "proactive" }, { ...channel, legKeys: new Set(["conversation_to_meeting_booked"]) }, TRIGGERS), 409, "leg_exists");
    refused(() => parseLegInput({ toStep: "meeting_booked", mode: "proactive" }, channel, TRIGGERS), 400, "from_step_required");
    refused(() => parseLegInput({ fromStep: "signup", toStep: "signup", mode: "proactive" }, channel, TRIGGERS), 400, "leg_goes_nowhere");
    // An outbound channel's `lead_found_to_conversation` IS its computed `start_to_conversation` entry leg.
    refused(
      () => parseLegInput({ fromStep: "lead_found", toStep: "conversation", mode: "proactive" }, { slug: "sales-cold-email-outreach", managed: true, legKeys: new Set(["start_to_conversation"]) }, TRIGGERS),
      409,
      "leg_exists",
    );
  });
});

describe("declared trigger types are never coded on their own say-so", () => {
  it("a delay trigger is campaign-service's, with its parameters", () => {
    const t = parseTriggerInput({ id: "no_reply_3d", label: "No reply", description: "x", icon: "clock", kind: "delay", params: { afterStep: "lead_found", days: 3 } }, TRIGGERS);
    expect(t).toMatchObject({ kind: "delay", fromStep: "lead_found", params: { afterStep: "lead_found", days: 3 }, firedBy: "campaign-service" });
  });
  it("refuses a duplicate id, a declared `coded`, a second event on a step a trigger already fires", () => {
    refused(() => parseTriggerInput({ id: "lead_requested", label: "x", description: "x", icon: "x", kind: "event" }, TRIGGERS), 409, "trigger_exists");
    refused(() => parseTriggerInput({ id: "new_one", label: "x", description: "x", icon: "x", kind: "event", coded: true }, TRIGGERS), 400, "coded_not_declarable");
    refused(() => parseTriggerInput({ id: "new_one", label: "x", description: "x", icon: "x", kind: "event", fromStep: "conversation" }, TRIGGERS), 409, "trigger_exists_for_step");
  });

  const SOURCE = { endpoint: "linkedin.jobs.search", method: "GET", query: { keywords: "cfo" }, items: "data.jobs", itemId: "id", maxMicro: 20_000 };
  const pollBody = (params: unknown) => ({ id: "new_job_post", label: "New job post", description: "x", icon: "briefcase", kind: "poll", params });
  const delayBody = (params: unknown) => ({ id: "no_reply_3d", label: "No reply", description: "x", icon: "clock", kind: "delay", params });

  it("a poll trigger stores its treg call as JSON text, from an object or from text", () => {
    const t = parseTriggerInput(pollBody({ source: SOURCE, everyMinutes: 60 }), TRIGGERS);
    expect(t).toMatchObject({ kind: "poll", fromStep: null, firedBy: "campaign-service", params: { everyMinutes: 60 } });
    expect(JSON.parse((t.params as { source: string }).source)).toEqual(SOURCE);
    expect(parseTriggerInput(pollBody({ source: JSON.stringify(SOURCE), everyMinutes: 5 }), TRIGGERS).params).toEqual(t.params && { ...t.params, everyMinutes: 5 });
  });

  it("refuses malformed delay / poll params with a named error, so no detector ever reads them", () => {
    refused(() => parseTriggerInput(delayBody(undefined), TRIGGERS), 400, "params_required");
    refused(() => parseTriggerInput(delayBody({ afterStep: "nowhere", days: 3 }), TRIGGERS), 400, "step_unrecognised");
    refused(() => parseTriggerInput(delayBody({ afterStep: "lead_found", days: 0 }), TRIGGERS), 400, "delay_days_invalid");
    refused(() => parseTriggerInput(delayBody({ afterStep: "lead_found", days: 1.5 }), TRIGGERS), 400, "delay_days_invalid");
    refused(() => parseTriggerInput(pollBody(undefined), TRIGGERS), 400, "params_required");
    refused(() => parseTriggerInput(pollBody({ source: SOURCE, everyMinutes: 1 }), TRIGGERS), 400, "poll_every_minutes_invalid");
    refused(() => parseTriggerInput(pollBody({ source: "rss", everyMinutes: 60 }), TRIGGERS), 400, "poll_source_invalid");
    for (const broken of [
      { ...SOURCE, endpoint: "bad endpoint/x" },
      { ...SOURCE, method: "DELETE" },
      { ...SOURCE, query: { n: 3 } },
      { ...SOURCE, body: [] },
      { ...SOURCE, items: undefined },
      { ...SOURCE, itemId: "" },
      { ...SOURCE, maxMicro: 0 },
      { ...SOURCE, maxMicro: 1_000_001 },
      { ...SOURCE, url: "https://x" },
    ]) {
      refused(() => parseTriggerInput(pollBody({ source: broken, everyMinutes: 60 }), TRIGGERS), 400, "poll_source_invalid");
    }
  });
});

describe("a declared channel", () => {
  it("validates like the catalogue parser, and never takes a feature's slug or name", () => {
    expect(parseChannelInput(channelBody, new Set(), new Set()).slug).toBe("whatsapp-concierge");
    refused(() => parseChannelInput({ ...channelBody, slug: "sales-cold-email-outreach" }, new Set(["sales-cold-email-outreach"]), new Set()), 409, "channel_exists");
    refused(() => parseChannelInput(channelBody, new Set(), new Set(["whatsapp concierge"])), 409, "channel_name_taken");
    refused(() => parseChannelInput({ ...channelBody, operatedBy: "customer", performedBy: "software" }, new Set(), new Set()), 400, "customer_channel_must_be_person");
    refused(() => parseChannelInput({ ...channelBody, channelType: "tool" }, new Set(), new Set()), 400, "channel_type_unrecognised");
    refused(() => parseChannelInput({ ...channelBody, dailyOperatingCostCents: 1.5 }, new Set(), new Set()), 400, "dailyOperatingCostCents_invalid");
  });

  it("reaches the client catalogue ONLY when the channel and its leg are published", () => {
    const seededCount = buildChannelCatalogue(SEEDED).length;
    expect(build([declaredChannel()], [declaredLeg()], true)).toHaveLength(seededCount);
    expect(build([declaredChannel({ published: true })], [declaredLeg()], true)).toHaveLength(seededCount);
    expect(build([declaredChannel()], [declaredLeg({ published: true })], true)).toHaveLength(seededCount);
    const pub = build([declaredChannel({ published: true })], [declaredLeg({ published: true })], true);
    const entry = pub.find((c) => c.slug === "whatsapp-concierge")!;
    expect(entry).toMatchObject({ name: "WhatsApp Concierge", channelType: "conversion", shortDescription: "Answers buyers on WhatsApp", managed: false, salesPathEligible: false });
    expect(entry.stepTransitions.map((t) => [t.legKey, t.mode, t.triggerId, t.reactive])).toEqual([["conversation_to_meeting_booked", "reactive", "positive_reply_received", true]]);
    // Internal reads see it unpublished.
    expect(build([declaredChannel()], [declaredLeg()], false).some((c) => c.slug === "whatsapp-concierge")).toBe(true);
  });

  it("a declared leg on a SEEDED channel joins that channel's legs, published only", () => {
    const leg = declaredLeg({ channelSlug: "ai-meeting-booking", legKey: "website_visit_to_meeting_booked", fromStep: "website_visit", toStep: "meeting_booked", mode: "proactive", triggerId: null });
    const before = buildChannelCatalogue(SEEDED).find((c) => c.slug === "ai-meeting-booking")!.stepTransitions.length;
    expect(build([], [leg], true).find((c) => c.slug === "ai-meeting-booking")!.stepTransitions).toHaveLength(before);
    expect(build([], [{ ...leg, published: true }], true).find((c) => c.slug === "ai-meeting-booking")!.stepTransitions).toHaveLength(before + 1);
  });

  it("the catalogue build still refuses a stored leg naming a trigger nothing fires on a channel we run", () => {
    const bad = declaredLeg({ channelSlug: "ai-meeting-booking", legKey: "meeting_booked_to_meeting_attended", fromStep: "meeting_booked", toStep: "meeting_attended", triggerId: "meeting_booked", published: true });
    expect(() => build([], [bad], true)).toThrow(/nothing fires yet/);
  });

  it("states where its price comes from, never a made-up number", () => {
    expect(legPricingOf({ slug: "whatsapp-concierge", operatedBy: "platform" }, "conversation_to_meeting_booked")).toEqual({ source: "learning", costPerOutcomeUsd: null, benchmarkSource: null });
    expect(legPricingOf({ slug: "ai-meeting-booking", operatedBy: "platform" }, "conversation_to_meeting_booked").source).toBe("workflow_ladder");
    expect(legPricingOf({ slug: "your-team-meeting-booking", operatedBy: "customer" }, "conversation_to_meeting_booked").source).toBe("customer_time");
    expect(legPricingOf({ slug: "google-ads", operatedBy: "platform" }, "start_to_website_visit")).toMatchObject({ source: "benchmark", costPerOutcomeUsd: 5.87 });
  });
});

describe("a declared sales path is a chain of existing legs, start to paid client", () => {
  const catalogue = build(
    [declaredChannel()],
    [declaredLeg()],
    false,
  );
  const path = (legs: Array<[string, string]>) => parseSalesPathInput({ legs: legs.map(([channelSlug, legKey]) => ({ channelSlug, legKey })) }, catalogue, combinationKeyOf);

  it("chains a seeded entry leg into the declared leg and on to a paid client", () => {
    const result = path([
      ["sales-cold-email-outreach", "lead_found_to_conversation"],
      ["whatsapp-concierge", "conversation_to_meeting_booked"],
      ["your-team-meeting-attendance", "meeting_booked_to_meeting_attended"],
      ["your-team-closing-calls", "meeting_attended_to_paid_client"],
    ]);
    expect(result.combinationKey).toBe(
      "start_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@whatsapp-concierge+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
    );
    expect(result.legs[0]).toEqual({ channelSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" });
  });

  it("refuses a broken chain, an unknown leg, a path that never pays", () => {
    refused(() => path([["sales-cold-email-outreach", "start_to_conversation"], ["your-team-closing-calls", "meeting_attended_to_paid_client"]]), 400, "path_not_chained");
    refused(() => path([["whatsapp-concierge", "start_to_conversation"]]), 404, "leg_not_found");
    refused(() => path([["nope", "start_to_conversation"]]), 404, "channel_not_found");
    refused(() => path([["sales-cold-email-outreach", "start_to_conversation"], ["whatsapp-concierge", "conversation_to_meeting_booked"]]), 400, "path_must_end_paid");
    refused(() => path([["whatsapp-concierge", "conversation_to_meeting_booked"]]), 400, "path_must_start");
  });
});
