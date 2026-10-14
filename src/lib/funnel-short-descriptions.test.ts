import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCatalogueModel, funnelsOfPath } from "./agent-catalogue.js";
import { funnelShortDescriptionOf } from "../routes/agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import { funnelShortDescription, MAX_WORDS, type SummaryChannel, type SummaryLeg } from "./funnel-short-descriptions.js";

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

// The PROD catalogue (seed + DB-declared channels, legs, steps and triggers), captured 2026-10-14 from the
// features-service container: a declared channel ("Social post", "Email Sending") reads through the fallbacks.
const prod = JSON.parse(readFileSync(new URL("./__fixtures__/prod-funnel-catalogue.json", import.meta.url), "utf8")) as {
  legs: SummaryLeg[];
  funnels: Array<[0 | 1, string | null, ...number[]]>;
};
const prodInputs = prod.funnels.map(([r, t, ...li]) => ({ reactive: r === 1, triggerId: t, legs: li.map((i) => prod.legs[i]) }));
const seedInputs = all.map((f) => ({ f, out: funnelShortDescriptionOf(model, f) }));
const everySentence = [...new Set([...seedInputs.map((x) => x.out.shortDescription), ...prodInputs.map((i) => funnelShortDescription(i).shortDescription)].filter((s): s is string => s !== null))].sort();

// A channel's display name never reaches the sentence (owner 2026-10-14: "We run Social post to bring you buyers"),
// except names that ARE plain English: a platform's own word for its ads, or a bare platform/medium word.
const NAME_ALLOWLIST = new Set(["linkedin", "email", "google ads", "meta ads", "linkedin ads", "tiktok ads", "youtube ads", "reddit ads", "bing ads", "quora ads", "your crm contacts", "affiliate programme"]);
const channelNames = [...new Set([...channels.map((c) => c.name), ...prod.legs.flatMap((l) => (l.channel ? [l.channel.name] : []))])];

// Customer copy rules (owner 2026-10-14 + humanizer): no dash, no internal word, never opens, never effort/cost/risk.
const BANNED = /—|–| - |\bfunnels?\b|\bpipes?\b|\blegs?\b|\bworkflows?\b|\bchannels?\b|\bagency\b|\bopens?\b|\bopened\b|\beffort\b|\bcosts?\b|\brisks?\b|undefined|null/i;

describe("one short customer sentence per sales funnel (owner 2026-10-14)", () => {
  it("over the WHOLE catalogue (seed and prod): at most 12 words, no dash, no banned word", () => {
    expect(all.length).toBeGreaterThan(1000);
    expect(prodInputs.length).toBeGreaterThan(2000);
    let served = 0;
    for (const { f, out } of seedInputs) {
      if (out.shortDescription === null) {
        expect(out.reason).toBe("no_step_run_by_us");
        expect(f.legs.every((l) => l.pipe?.operatedBy === "customer")).toBe(true);
      } else served += 1;
    }
    for (const i of prodInputs) {
      const out = funnelShortDescription(i);
      if (out.shortDescription === null) expect(i.legs.every((l) => !l.runByUs)).toBe(true);
    }
    expect(served).toBeGreaterThan(all.length * 0.9);
    for (const s of everySentence) {
      expect(s.split(/\s+/).length, s).toBeLessThanOrEqual(MAX_WORDS);
      expect(s, s).toMatch(/^(We|Our AI) [a-z][^.]*\.$/);
      expect(s, s).not.toMatch(BANNED);
    }
  });

  it("never pastes a channel's display name, unless the name is plain English", () => {
    for (const s of everySentence) {
      for (const name of channelNames) {
        if (NAME_ALLOWLIST.has(name.toLowerCase())) continue;
        expect(s.toLowerCase().includes(name.toLowerCase()), `"${s}" names the channel "${name}"`).toBe(false);
      }
    }
  });

  it("never repeats a phrase in one sentence", () => {
    for (const s of everySentence) expect(s, s).not.toMatch(/(\b\w+ \w+ by email)\b.*\1/);
  });

  it("the live examples the owner flagged read as plain English (2026-10-14)", () => {
    const ch = (slug: string, name: string, channelType: SummaryChannel["channelType"]): SummaryChannel => ({ slug, name, channelType, performedBy: "software", operatedBy: "platform" });
    const socialPost = funnelShortDescription({ reactive: false, triggerId: null, legs: [{ fromStep: null, toStep: "industry_update_video", channel: ch("social-post", "Social post", "earned"), runByUs: true }] });
    expect(socialPost.shortDescription).toBe("We post on social media.");
    const emailSending = funnelShortDescription({ reactive: true, triggerId: "email_pushed_via_api", legs: [{ fromStep: null, toStep: "conversation", channel: ch("email-sending", "Email Sending", "outbound"), runByUs: true }] });
    expect(emailSending.shortDescription).toBe("We email the leads you send us until they reply with interest.");
    expect(say("conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")).toBe("Our AI books meetings with buyers who reply with interest.");
  });

  it("prints EVERY distinct sentence, for a human read", () => {
    console.log(`${everySentence.length} distinct sentences:\n${everySentence.join("\n")}`);
    expect(everySentence.length).toBeGreaterThan(100);
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

  it("a channel this file does not name reads by its kind in plain words, never its display name", () => {
    const ch = (slug: string, name: string, channelType: SummaryChannel["channelType"]): SummaryChannel => ({ slug, name, channelType, performedBy: "software", operatedBy: "platform" });
    const telegram = funnelShortDescription({
      reactive: false,
      triggerId: null,
      legs: [
        { fromStep: null, toStep: "lead_found", channel: ch("lead-sourcing", "Lead Sourcing", "sourcing"), runByUs: true },
        { fromStep: "lead_found", toStep: "conversation", channel: ch("cold-telegram-outreach", "Cold Telegram Outreach", "outbound"), runByUs: true },
      ],
    });
    expect(telegram.shortDescription).toBe("We reach out to new buyers until they reply with interest.");
    const spotify = funnelShortDescription({ reactive: false, triggerId: null, legs: [{ fromStep: null, toStep: "website_visit", channel: ch("spotify-ads", "Spotify Ads", "paid"), runByUs: true }] });
    expect(spotify.shortDescription).toBe("We run ads to bring buyers to your site.");
    const agencyNamed = funnelShortDescription({ reactive: false, triggerId: null, legs: [{ fromStep: null, toStep: "website_visit", channel: ch("agency-webinars", "Agency Webinars", "earned"), runByUs: true }] });
    expect(agencyNamed.shortDescription).not.toMatch(/agency/i);
  });

  it("null + reason when the client's own team works every step", () => {
    expect(funnelShortDescription({ reactive: true, triggerId: "conversation", legs: [{ fromStep: "conversation", toStep: "paid_client", channel: { slug: "your-team-reply-closing", name: "Your Team Reply Closing", channelType: "conversion", performedBy: "person", operatedBy: "customer" }, runByUs: false }] })).toEqual({ shortDescription: null, reason: "no_step_run_by_us" });
  });
});
