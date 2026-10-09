/**
 * The outbound leg rename, wave 2, SERVED half (`lib/served-leg-keys.ts`): an outbound channel's leg goes out
 * as `lead_found_to_*` wherever a response names it; a non-outbound channel's and a channel-less funnel leg
 * stay `start_to_*`; the legacy spelling is still accepted on the way in.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { sendSnapshotJson, SnapshotJson } = await import("./view-cache.js");
import { routeChannelOf, serveOutboundLegKeys, servedJsonTextOf, servedLegKeysMiddleware } from "./served-leg-keys.js";
import {
  matchChannelLegKey,
  servedCampaignKeyOf,
  servedCombinationKeyOf,
  servedLegKeyOf,
  storedCombinationKeyOf,
} from "./funnel-legs.js";

const COLD = "sales-cold-email-outreach";

describe("the served spelling of one key", () => {
  it("re-spells the two entry legs of an OUTBOUND channel, nothing else", () => {
    expect(servedLegKeyOf(COLD, "start_to_conversation")).toBe("lead_found_to_conversation");
    expect(servedLegKeyOf("cold-linkedin-outreach", "start_to_website_visit")).toBe("lead_found_to_website_visit");
    expect(servedLegKeyOf(COLD, "conversation_to_meeting_booked")).toBe("conversation_to_meeting_booked");
    expect(servedLegKeyOf("google-ads", "start_to_website_visit")).toBe("start_to_website_visit");
    expect(servedLegKeyOf("organic-linkedin-publishing", "start_to_conversation")).toBe("start_to_conversation");
    expect(servedLegKeyOf(null, "start_to_conversation")).toBe("start_to_conversation");
    expect(servedLegKeyOf("sourcing-apollo-cold-filters", "start_to_lead_found")).toBe("start_to_lead_found");
  });

  it("a combination key re-spells only its outbound legs, and reads back to the computed key", () => {
    const computed = "start_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
    const served = servedCombinationKeyOf(computed);
    expect(served).toBe(
      "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client",
    );
    expect(storedCombinationKeyOf(served)).toBe(computed);
    const ads = "start_to_website_visit@google-ads+website_visit_to_signup+signup_to_paid_client";
    expect(servedCombinationKeyOf(ads)).toBe(ads);
  });

  it("a campaign key re-spells its leg when its channel is outbound", () => {
    expect(servedCampaignKeyOf("campaign:sales-cold-email-outreach|start_to_conversation")).toBe("campaign:sales-cold-email-outreach|lead_found_to_conversation");
    expect(servedCampaignKeyOf("campaign:google-ads|start_to_website_visit")).toBe("campaign:google-ads|start_to_website_visit");
    expect(servedCampaignKeyOf("campaign:sourcing-crm-contacts|start_to_lead_found")).toBe("campaign:sourcing-crm-contacts|start_to_lead_found");
  });

  it("the legacy spelling is still ACCEPTED on input, as the new one is", () => {
    expect(matchChannelLegKey(COLD, "start_to_conversation")).toBe("start_to_conversation");
    expect(matchChannelLegKey(COLD, "lead_found_to_conversation")).toBe("start_to_conversation");
    expect(matchChannelLegKey("google-ads", "lead_found_to_website_visit")).toBeNull();
  });
});

describe("the served body", () => {
  it("reads the channel off the nearest object, then the route", () => {
    const body = {
      legKey: "start_to_conversation",
      campaigns: [
        { featureSlug: COLD, legKey: "start_to_website_visit", fromStep: null, toStep: { key: "website_visit", label: "Website visit" } },
        { featureSlug: "google-ads", legKey: "start_to_website_visit" },
        { channel: { slug: COLD }, legKey: "start_to_conversation" },
      ],
      // A workflow slug is not a channel: the route's channel still holds.
      workflow: { slug: "keel", legKey: "start_to_conversation" },
    };
    const served = serveOutboundLegKeys(body, COLD);
    expect(served.legKey).toBe("lead_found_to_conversation");
    expect(served.campaigns[0]).toEqual({
      featureSlug: COLD,
      legKey: "lead_found_to_website_visit",
      fromStep: { key: "lead_found", label: "Lead found" },
      toStep: { key: "website_visit", label: "Website visit" },
    });
    expect(served.campaigns[1].legKey).toBe("start_to_website_visit");
    expect(served.campaigns[2].legKey).toBe("lead_found_to_conversation");
    expect(served.workflow.legKey).toBe("lead_found_to_conversation");
    // No channel anywhere: a funnel's own entry leg stays as it is.
    expect(serveOutboundLegKeys(body.workflow, null)).toEqual(body.workflow);
  });

  it("a sales-path row's chain follows its combination's ENTRY channel; campaign and combination keys carry their own", () => {
    const row = {
      combinationKey: "start_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
      pathKey: "start_to_conversation+conversation_to_paid_client",
      legKeys: ["start_to_conversation", "conversation_to_paid_client"],
      entryLegKey: "start_to_conversation",
      legs: [{ legKey: "start_to_conversation", channel: { slug: COLD }, fromStep: null, toStep: { key: "conversation", label: "Positive reply" } }],
    };
    const body = { paths: [row], campaigns: [{ campaignKey: "campaign:sales-cold-email-outreach|start_to_conversation", roiCombinationKey: row.combinationKey }] };
    const served = serveOutboundLegKeys(body);
    expect(served.paths[0]).toMatchObject({
      combinationKey: "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
      pathKey: "lead_found_to_conversation+conversation_to_paid_client",
      legKeys: ["lead_found_to_conversation", "conversation_to_paid_client"],
      entryLegKey: "lead_found_to_conversation",
    });
    expect(served.paths[0].legs[0].fromStep).toEqual({ key: "lead_found", label: "Lead found" });
    expect(served.campaigns[0]).toEqual({
      campaignKey: "campaign:sales-cold-email-outreach|lead_found_to_conversation",
      roiCombinationKey: "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client",
    });
    // A Google Ads row is untouched.
    const ads = { combinationKey: "start_to_website_visit@google-ads+website_visit_to_signup+signup_to_paid_client", pathKey: "start_to_website_visit+website_visit_to_signup+signup_to_paid_client" };
    expect(serveOutboundLegKeys(ads)).toEqual(ads);
  });

  it("the legacy/new correspondence is published verbatim (its legacyLegKey is not a leg field)", () => {
    const body = { legKeyCorrespondence: [{ channelType: "outbound", legacyLegKey: "start_to_conversation", legKey: "lead_found_to_conversation" }] };
    expect(serveOutboundLegKeys(body, COLD)).toEqual(body);
  });

  it("a text with no legacy key is returned as is, byte for byte", () => {
    const text = JSON.stringify({ legKey: "conversation_to_meeting_booked", featureSlug: COLD });
    expect(servedJsonTextOf(text, COLD)).toBe(text);
  });

  it("names the route's channel from the path or ?featureSlug=", () => {
    expect(routeChannelOf({ path: `/features/${COLD}/revenue`, query: {} } as never)).toBe(COLD);
    expect(routeChannelOf({ path: `/internal/features/${COLD}/workflow-projection/actual-cost`, query: {} } as never)).toBe(COLD);
    expect(routeChannelOf({ path: "/public/stats/leg-workflow-ranking", query: { featureSlug: COLD } } as never)).toBe(COLD);
    expect(routeChannelOf({ path: "/offers/o1/sales-paths", query: {} } as never)).toBeNull();
    expect(routeChannelOf(undefined)).toBeNull();
  });
});

describe("every response goes out in the served spelling: res.json AND a stored snapshot", () => {
  const app = express();
  app.use(servedLegKeysMiddleware);
  app.get("/features/:slug/json", (_req, res) => {
    res.json({ legKey: "start_to_conversation" });
  });
  app.get("/features/:slug/snapshot", (_req, res) => {
    sendSnapshotJson(res, new SnapshotJson(JSON.stringify({ legKey: "start_to_website_visit" })));
  });

  it("res.json on an outbound channel's route", async () => {
    const res = await request(app).get(`/features/${COLD}/json`);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ legKey: "lead_found_to_conversation" });
    expect((await request(app).get("/features/google-ads/json")).body).toEqual({ legKey: "start_to_conversation" });
  });

  it("a Gold snapshot sent as stored text, per route channel", async () => {
    expect((await request(app).get(`/features/${COLD}/snapshot`)).body).toEqual({ legKey: "lead_found_to_website_visit" });
    expect((await request(app).get("/features/google-ads/snapshot")).body).toEqual({ legKey: "start_to_website_visit" });
  });
});
