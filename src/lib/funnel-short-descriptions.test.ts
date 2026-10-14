import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCatalogueModel, funnelsOfPath } from "./agent-catalogue.js";
import { funnelShortDescriptionOf } from "../routes/agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { funnelShortDescription, MAX_WORDS, type SummaryChannel } from "./funnel-short-descriptions.js";

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const ids = new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`)));
const model = buildCatalogueModel({ channels, publishedPipeIds: ids, declaredSteps: [], measurements: new Map(), fleetMedians: new Map(), lifetimeRevenueUsd: 3000 });
const all = [...model.paths.values()].flatMap((p) => funnelsOfPath(model, p));
const byId = (id: string) => {
  const f = all.find((x) => x.id === id);
  if (!f) throw new Error(`no funnel ${id}`);
  return f;
};
const say = (id: string) => funnelShortDescriptionOf(model, byId(id)).shortDescription;
const LS = "start_to_lead_found@lead-sourcing+";

// Customer copy rules (owner 2026-10-14 + humanizer): no dash, no internal word, never opens, never effort/cost/risk.
const BANNED = /—|–| - |\bfunnels?\b|\bpipes?\b|\blegs?\b|\bworkflows?\b|\bchannels?\b|\bagency\b|\bopens?\b|\bopened\b|\beffort\b|\bcosts?\b|\brisks?\b|undefined|null/i;

describe("one short customer sentence per sales funnel (owner 2026-10-14)", () => {
  it("over the WHOLE catalogue: one sentence of at most 12 words, We-led, no dash, no banned word", () => {
    expect(all.length).toBeGreaterThan(1000);
    let served = 0;
    for (const f of all) {
      const { shortDescription: s, reason } = funnelShortDescriptionOf(model, f);
      if (s === null) {
        expect(reason).toBe("no_step_run_by_us");
        // Null only when the client's own team works every step.
        expect(f.legs.every((l) => l.pipe?.operatedBy === "customer")).toBe(true);
        continue;
      }
      served += 1;
      expect(reason).toBeNull();
      expect(s.split(/\s+/).length, s).toBeLessThanOrEqual(MAX_WORDS);
      expect(s, s).toMatch(/^We [a-z][^.]*\.$/);
      expect(s, s).not.toMatch(BANNED);
    }
    expect(served).toBeGreaterThan(all.length * 0.9);
  });

  it("two funnels whose work differs read differently (medium, who is reached, what we do next)", () => {
    const pairs: Array<[string, string]> = [
      [`${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`, `${LS}lead_found_to_conversation@cold-linkedin-outreach+conversation_to_paid_client`],
      [`start_to_lead_found@sourcing-apollo-buying-signals+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`, `${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`],
    ];
    for (const [a, b] of pairs) expect(say(a)).not.toBe(say(b));
  });

  it("reads the cold email funnel as the owner's example", () => {
    expect(say(`${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`)).toBe("We email new buyers until they reply with interest.");
  });

  it("prints one example per funnel kind", () => {
    const kinds: Array<[string, (f: (typeof all)[number]) => boolean]> = [
      ["proactive cold email", (f) => f.id === `${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`],
      ["cold email + AI meeting booking", (f) => f.legs[0].pipe?.channelSlug === "lead-sourcing" && f.legs[1]?.pipe?.channelSlug === "sales-cold-email-outreach" && f.legs[2]?.pipe?.channelSlug === "ai-meeting-booking" && f.legs.slice(3).every((l) => l.pipe?.operatedBy === "customer")],
      ["buying signals + cold email to site", (f) => f.legs[0].pipe?.channelSlug === "sourcing-apollo-buying-signals" && f.legs[1]?.pipe?.channelSlug === "sales-cold-email-outreach" && f.legs[1]?.pipe?.toStep === "website_visit" && f.legs.slice(2).every((l) => l.pipe?.operatedBy === "customer")],
      ["LinkedIn outreach", (f) => f.legs[0].pipe?.channelSlug === "lead-sourcing" && f.legs[1]?.pipe?.channelSlug === "cold-linkedin-outreach" && f.legs[1]?.pipe?.toStep === "conversation" && f.legs.slice(2).every((l) => l.pipe?.operatedBy === "customer")],
      ["LinkedIn posting", (f) => f.legs[0].pipe?.channelSlug === "organic-linkedin-publishing" && f.legs.slice(1).every((l) => l.pipe?.operatedBy === "customer")],
      ["Google Ads to a form", (f) => f.legs[0].pipe?.channelSlug === "google-ads" && f.legs[0].pipe?.toStep === "form_submitted" && f.legs.slice(1).every((l) => l.pipe?.operatedBy === "customer")],
      ["reactive positive reply", (f) => f.legs[0].pipe?.mode === "reactive" && f.legs[0].pipe?.channelSlug === "ai-meeting-booking" && f.legs.slice(1).every((l) => l.pipe?.operatedBy === "customer")],
      ["reactive meeting booked", (f) => f.legs[0].pipe?.mode === "reactive" && f.legs[0].pipe?.channelSlug === "agency-meeting-attendance" && f.legs.slice(1).every((l) => l.pipe?.operatedBy === "customer")],
      ["reactive signup follow-up", (f) => f.legs[0].pipe?.mode === "reactive" && f.legs.at(-1)?.pipe?.channelSlug === "ai-follow-up-email" && f.legs[0].pipe?.fromStep === "website_visit"],
      ["reactive form", (f) => f.legs[0].pipe?.mode === "reactive" && f.legs[0].pipe?.fromStep === "form_submitted" && f.legs[0].pipe?.channelSlug === "agency-signup-conversion"],
    ];
    const lines = kinds.map(([kind, pick]) => {
      const f = all.find(pick);
      expect(f, kind).toBeDefined();
      return `${kind}: ${funnelShortDescriptionOf(model, f!).shortDescription}`;
    });
    console.log(lines.join("\n"));
    expect(lines).toHaveLength(10);
  });

  it("a channel this file does not name reads by its kind, never a throw and never its internal words", () => {
    const ch = (slug: string, name: string, channelType: SummaryChannel["channelType"]): SummaryChannel => ({ slug, name, channelType, performedBy: "software", operatedBy: "platform" });
    const telegram = funnelShortDescription({
      reactive: false,
      triggerId: null,
      legs: [
        { fromStep: null, toStep: "lead_found", channel: ch("lead-sourcing", "Lead Sourcing", "sourcing"), runByUs: true },
        { fromStep: "lead_found", toStep: "conversation", channel: ch("cold-telegram-outreach", "Cold Telegram Outreach", "outbound"), runByUs: true },
      ],
    });
    expect(telegram.shortDescription).toBe("We reach new buyers through cold telegram until they reply with interest.");
    const spotify = funnelShortDescription({ reactive: false, triggerId: null, legs: [{ fromStep: null, toStep: "website_visit", channel: ch("spotify-ads", "Spotify Ads", "paid"), runByUs: true }] });
    expect(spotify.shortDescription).toBe("We run Spotify Ads to bring buyers to your site.");
    const agencyNamed = funnelShortDescription({ reactive: false, triggerId: null, legs: [{ fromStep: null, toStep: "website_visit", channel: ch("agency-webinars", "Agency Webinars", "earned"), runByUs: true }] });
    expect(agencyNamed.shortDescription).not.toMatch(/agency/i);
  });

  it("null + reason when the client's own team works every step", () => {
    expect(funnelShortDescription({ reactive: true, triggerId: "conversation", legs: [{ fromStep: "conversation", toStep: "paid_client", channel: { slug: "your-team-reply-closing", name: "Your Team Reply Closing", channelType: "conversion", performedBy: "person", operatedBy: "customer" }, runByUs: false }] })).toEqual({ shortDescription: null, reason: "no_step_run_by_us" });
  });
});
