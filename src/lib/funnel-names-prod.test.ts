import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { parseFunnelKey } from "./funnel-names.js";
import { planFunnelRenames, seedPipeTriggerOf } from "./sales-path-names.js";
import { funnelShortDescription, type SummaryChannel, type SummaryInput } from "./funnel-short-descriptions.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { registerTriggerConditions } from "./trigger-conditions.js";

// FUNNEL-NAMES-NO-NUMBERS-1027 (owner 2026-10-27): « j'ai marre de tes campagnes avec des noms avec des chiffres » and
// « chaque description doit être unique dans une brand ». Captured from prod the same day: every funnel the catalogue
// named (1,358 ids) and, per brand running two funnels or more, the funnel ids its campaigns run (brands anonymised).
const ALL = JSON.parse(readFileSync(new URL("./__fixtures__/prod-funnel-keys.json", import.meta.url), "utf8")) as string[];
const BRANDS = JSON.parse(readFileSync(new URL("./__fixtures__/prod-brand-funnel-keys.json", import.meta.url), "utf8")) as string[][];
const DOC_DINNERS_FOLLOW_UP_DUE = "start_to_lead_found@lead-sourcing~lead-follow-up-due+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const DOC_DINNERS_TWO_MONTHS = "start_to_lead_found@lead-sourcing~valid-catch-all-2-months+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
// Plays staff retired from the cold email pipe (PLAY-RETIRE-1022): their funnel ids read as the pipe's default.
const RETIRED_PLAYS = new Set(["sales-cold-email-outreach~valid-catch-all", "sales-cold-email-outreach~valid-only"]);
const WIDE = "start_to_lead_found@lead-sourcing~valid-catch-all+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";

/** The funnel a campaign id reads as (`funnelById`): a legacy id is its Lead Sourcing funnel, a retired play the default. */
const canonical = (key: string): string => {
  const current = key.startsWith("lead_found_to_") ? `start_to_lead_found@lead-sourcing+${key}` : key; // legacyFunnelIdAliasOf
  return current.split("+").map((p) => (RETIRED_PLAYS.has(p.split("@")[1] ?? "") ? p.split("~")[0] : p)).join("+");
};

/** Every funnel named from scratch, the way the rename pass names them: customers' funnels first (canonical ids). */
function nameEverything(): Map<string, string> {
  const at = new Date(Date.UTC(2026, 9, 1));
  const rows = ALL.map((k) => ({ combinationKey: k, name: "Zenith", assignedAt: at }));
  const firstKeys = [...new Set(BRANDS.flat().map(canonical))];
  const plan = planFunnelRenames(rows, new Set(), firstKeys, triggerOfPipe);
  return new Map(plan.map((p) => [p.combinationKey, p.to]));
}

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const prodLegs = (JSON.parse(readFileSync(new URL("./__fixtures__/prod-funnel-catalogue.json", import.meta.url), "utf8")) as { legs: Array<{ channel: SummaryChannel | null }> }).legs;
const channelBySlug = new Map<string, SummaryChannel>([
  ...prodLegs.flatMap((l) => (l.channel ? [[l.channel.slug, l.channel] as const] : [])),
  ...channels.map((c) => [c.slug, c] as const),
]);

// The prod declarations the sentence reads (2026-10-27): the trigger of each declared reactive pipe, and the condition
// triggers' params (`registerTriggerConditions`, filled by every catalogue load in prod).
const DECLARED_PIPE_TRIGGERS: Readonly<Record<string, string>> = {
  "ai-meeting-booking|form_submitted_to_meeting_booked": "form_submitted",
  "email-sending|start_to_conversation": "email_pushed_via_api",
  "email-sending|start_to_email_sent": "email_pushed_via_api",
  "ai-follow-up-email|start_to_conversation": "follow_up_date_reached",
  "ai-follow-up-email|website_visit_to_signup": "website_visit_no_signup_30_min",
  "ai-follow-up-email|start_to_paid_client": "signup_not_paid_30_min",
  "cold-whatsapp-outreach|signup_to_paid_client": "signup_not_paid_24_hours",
  "ai-instant-call|form_submitted_to_booking_call": "form_submitted",
  "cold-whatsapp-outreach|start_to_signup": "whatsapp_number_given",
  "ai-lead-proposal|start_to_paid_client": "hot_lead",
};
const CONDITIONS = [
  { id: "signup_not_paid_30_min", kind: "delay", params: { minutes: 30, afterStep: "signup", unlessStep: "paid_client" } },
  { id: "signup_not_paid_24_hours", kind: "delay", params: { minutes: 1440, afterStep: "signup", unlessStep: "paid_client" } },
  { id: "website_visit_no_signup_30_min", kind: "delay", params: { minutes: 30, afterStep: "website_visit", unlessStep: "signup" } },
  { id: "signup_not_paid_5_min", kind: "delay", params: { minutes: 5, afterStep: "signup", unlessStep: "paid_client" } },
];
const triggerOfPipe = (slug: string, legKey: string): string | null => DECLARED_PIPE_TRIGGERS[`${slug}|${legKey}`] ?? seedPipeTriggerOf(slug, legKey);

/** The sentence the campaigns table serves for a funnel id (seed + prod channels, retired plays read as default). */
function sentenceOf(key: string): string | null {
  const { headTrigger, legs } = parseFunnelKey(key);
  const rawParts = key.split("+").filter((p) => !p.startsWith("trigger:"));
  const summary: SummaryInput["legs"] = legs.map((l, i) => {
    const managed = rawParts[i]?.split("@")[1] ?? null;
    const slug = managed?.split("~")[0] ?? null;
    const c = slug ? (channelBySlug.get(slug) ?? null) : null;
    const strategy = managed && managed.includes("~") && !RETIRED_PLAYS.has(managed) ? managed.split("~")[1] : null;
    return { fromStep: l.fromStep === "start" ? null : l.fromStep, toStep: l.toStep, channel: c, runByUs: c?.operatedBy === "platform", strategy };
  });
  const first = rawParts[0]?.split("@")[1]?.split("~")[0] ?? null;
  const firstTrigger = first ? triggerOfPipe(first, rawParts[0].split("@")[0]) : null;
  const reactive = headTrigger !== null || firstTrigger !== null || (legs[0]?.fromStep !== "start" && legs[0]?.fromStep !== "lead_found");
  return funnelShortDescription({ legs: summary, triggerId: headTrigger ?? firstTrigger, reactive }).shortDescription;
}

describe("a funnel name never carries a number; a brand never shows two alike (FUNNEL-NAMES-NO-NUMBERS-1027)", () => {
  registerTriggerConditions(CONDITIONS);
  afterAll(() => registerTriggerConditions([]));
  const names = nameEverything();

  it("names the whole prod catalogue with no digit anywhere", () => {
    expect(names.size).toBe(ALL.length);
    const numbered = [...names.values()].filter((n) => /\d/.test(n));
    expect(numbered).toEqual([]);
    for (const n of names.values()) {
      expect(n.split(" ").length, n).toBeGreaterThanOrEqual(2);
      expect(n.split(" ").length, n).toBeLessThanOrEqual(3);
      expect(n, n).not.toMatch(/[—–]|\b(funnel|pipe|leg|workflow|channel|agency|catch|strategy)\b/i);
    }
  });

  it("every brand's funnels read with distinct names and distinct sentences", () => {
    for (const raw of BRANDS) {
      const keys = [...new Set(raw.map(canonical))];
      const brandNames = keys.map((k) => names.get(k));
      expect(new Set(brandNames).size, brandNames.join(" | ")).toBe(keys.length);
      const sentences = keys.map(sentenceOf).filter((s): s is string => s !== null);
      const dup = sentences.filter((s, i) => sentences.indexOf(s) !== i);
      expect(dup, keys.map((k) => `${k} => ${sentenceOf(k)}`).join("\n")).toEqual([]);
    }
  });

  it("the Doc Dinners funnels say what differs (people who acted, re-contacted after 2 months)", () => {
    expect(names.get(DOC_DINNERS_FOLLOW_UP_DUE)).toBe("Active Email Replies");
    expect(names.get(DOC_DINNERS_TWO_MONTHS)).toBe("Frequent Wide Email");
    expect(names.get(WIDE)).toBe("Wide Email Replies");
    expect(sentenceOf(DOC_DINNERS_FOLLOW_UP_DUE)).toBe("We email people who acted, once their follow-up is due.");
    expect(sentenceOf(DOC_DINNERS_TWO_MONTHS)).toBe("We email new buyers, unconfirmed addresses included, every 2 months.");
    expect(sentenceOf(WIDE)).toBe("We email new buyers, unconfirmed addresses included, until they reply with interest.");
  });

  it("prints every brand's names and sentences, for a human read", () => {
    console.log(BRANDS.map((keys) => [...new Set(keys.map(canonical))].map((k) => `${names.get(k)}: ${sentenceOf(k)}`).join("\n")).join("\n---\n"));
    expect(BRANDS.length).toBeGreaterThan(10);
  });
});
