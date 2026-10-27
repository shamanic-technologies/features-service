import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { funnelNameCandidates, funnelNamingOrder, isComposedNameOf, nextFunnelName, parseFunnelKey } from "./funnel-names.js";
import { planFunnelRenames, SALES_PATH_NAME_POOL } from "./sales-path-names.js";
import { FUNNEL_EXTRA_WORDS } from "./catalogue-names.js";

const LS = "start_to_lead_found@lead-sourcing+";
const COLD_REPLIES = `${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client`;
const COLD_AI_MEETINGS = `${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client`;
const REPLY_BOOKING = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";
const first = (key: string, triggerOf?: Parameters<typeof funnelNameCandidates>[1]) => funnelNameCandidates(key, triggerOf)[0];

// Every funnel customers ran on 2026-10-16 (campaign-service), with the name it must read.
const LIVE: ReadonlyArray<[string, string]> = [
  [COLD_REPLIES, "Cold Email Replies"],
  [`${LS}lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client`, "Cold Email Replies"],
  [COLD_AI_MEETINGS, "Cold Email Meetings"],
  [REPLY_BOOKING, "Reply Booking"],
  ["conversation_to_booking_call@ai-instant-call+booking_call_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", "Reply Callback"],
  ["form_submitted_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", "Form Booking"],
  ["signup_to_paid_client@ai-follow-up-email", "Signup Follow-up"],
  ["website_visit_to_signup@ai-follow-up-email+signup_to_paid_client", "Visitor Follow-up"],
  ["start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_website_visit@sales-cold-email-outreach+website_visit_to_purchase+purchase_to_paid_client", "Targeted Email Orders"],
  ["start_to_lead_found@sourcing-apollo-buying-signals+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", "Intent Email Replies"],
  ["start_to_lead_found@sourcing-crm-contacts+lead_found_to_conversation@cold-whatsapp-outreach+conversation_to_paid_client", "CRM WhatsApp Replies"],
  ["start_to_lead_found@sourcing-crm-contacts~warm-never-converted+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client", "Warm Email Replies"],
  ["start_to_conversation@email-sending+conversation_to_paid_client", "API Email Replies"],
  ["start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_paid_client", "Targeted Leads"],
  ["trigger:lead_found+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client", "New Lead Email"],
];

describe("a sales funnel's name says what it does (owner 2026-10-16, FUNNEL-NAMES-1016)", () => {
  it("reads the legs of a key, trigger head and lead strategy included", () => {
    expect(parseFunnelKey("trigger:lead_found+lead_found_to_conversation@sales-cold-email-outreach~valid-catch-all+conversation_to_paid_client")).toEqual({
      headTrigger: "lead_found",
      legs: [
        { fromStep: "lead_found", toStep: "conversation", channel: "sales-cold-email-outreach", strategy: "valid-catch-all" },
        { fromStep: "conversation", toStep: "paid_client", channel: null, strategy: null },
      ],
    });
  });

  it.each(LIVE)("%s reads %s", (key, name) => {
    expect(first(key)).toBe(name);
  });

  it("a reactive pipe on a trigger other than its step's own names that trigger (the Copilot's release follow-up)", () => {
    const key = "conversation_to_paid_client@ai-follow-up-email";
    expect(first(key)).toBe("Reply Follow-up");
    expect(first(key, (s, l) => (s === "ai-follow-up-email" && l === "conversation_to_paid_client" ? "github_issue_in_prod" : null))).toBe("Release Follow-up");
  });

  it("every candidate is 2 or 3 plain English words: no pool word, no dash, no internal word", () => {
    const pool = new Set([...SALES_PATH_NAME_POOL, ...FUNNEL_EXTRA_WORDS]);
    for (const [key] of LIVE) {
      for (const c of funnelNameCandidates(key)) {
        const words = c.split(" ");
        expect(words.length, c).toBeGreaterThanOrEqual(2);
        expect(words.length, c).toBeLessThanOrEqual(3);
        expect(pool.has(c), c).toBe(false);
        expect(c, c).not.toMatch(/[—–]|\b(funnel|pipe|leg|workflow|channel|agency|catch)\b/i);
      }
    }
  });

  it("a taken name passes to the next candidate, and never to a number (owner 2026-10-27, FUNNEL-NAMES-NO-NUMBERS-1027)", () => {
    expect(nextFunnelName(COLD_AI_MEETINGS, new Set())).toBe("Cold Email Meetings");
    expect(nextFunnelName(COLD_AI_MEETINGS, new Set(["Cold Email Meetings"]))).toBe(funnelNameCandidates(COLD_AI_MEETINGS)[1]);
    const taken = new Set(funnelNameCandidates(COLD_AI_MEETINGS));
    expect(nextFunnelName(COLD_AI_MEETINGS, taken)).toBe("Cold Email Meetings");
    expect(isComposedNameOf(COLD_AI_MEETINGS, "Cold Email Meetings 2")).toBe(false);
    expect(isComposedNameOf(COLD_AI_MEETINGS, "Victory")).toBe(false);
  });

  it("a funnel customers run keeps its plain name even when a funnel nobody runs holds it (names may be shared)", () => {
    const at = new Date(Date.UTC(2026, 9, 1));
    const legacy = "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
    const rows = [
      { combinationKey: legacy, name: "Cold Email Replies", assignedAt: at },
      { combinationKey: COLD_REPLIES, name: "Cold Email Replies 2", assignedAt: at },
    ];
    expect(planFunnelRenames(rows, new Set(), [COLD_REPLIES], () => null)).toEqual([{ combinationKey: COLD_REPLIES, from: "Cold Email Replies 2", to: "Cold Email Replies" }]);
  });

  it("a funnel headed by a trigger answers that trigger's people, never its first pipe's trigger", () => {
    const leadEvent = "trigger:lead_event+start_to_paid_client@ai-follow-up-email";
    const signupPipe = () => "signup_not_paid_30_min";
    expect(first(leadEvent, signupPipe)).toBe("Lead Follow-up");
    expect(first(`${leadEvent}~current-clients`, signupPipe)).toBe("Client Lead Follow-up");
  });

  it("a lead strategy is in every candidate: a funnel never reads like its default twin", () => {
    const due = COLD_REPLIES.replace("@lead-sourcing+", "@lead-sourcing~lead-follow-up-due+");
    const twoMonths = COLD_REPLIES.replace("@lead-sourcing+", "@lead-sourcing~valid-only-2-months+");
    for (const c of funnelNameCandidates(due)) expect(c, c).toMatch(/\bActive\b/);
    for (const c of funnelNameCandidates(twoMonths)) expect(c, c).toMatch(/\bFrequent\b/);
    expect(first(due)).toBe("Active Email Replies");
    expect(first(twoMonths)).toBe("Frequent Cold Email");
    expect(first(COLD_REPLIES.replace("@lead-sourcing+", "@lead-sourcing~valid-only-6-months+"))).toBe("Patient Cold Email");
  });

  it("the plainest funnel is named first: a lead strategy or a trigger head yields", () => {
    const wide = COLD_REPLIES.replace("@sales-cold-email-outreach", "@sales-cold-email-outreach~valid-catch-all");
    const order = funnelNamingOrder([
      { key: wide, rank: 0 },
      { key: COLD_AI_MEETINGS, rank: 1 },
      { key: COLD_REPLIES, rank: 2 },
    ]).map((r) => r.key);
    expect(order).toEqual([COLD_REPLIES, COLD_AI_MEETINGS, wide]);
  });

  it("the rename plan: every word-named funnel, customers' funnels first, composed names and other families kept", () => {
    const at = (d: number) => new Date(Date.UTC(2026, 9, d));
    const rows = [
      { combinationKey: COLD_REPLIES, name: "Zenith", assignedAt: at(1) },
      { combinationKey: COLD_REPLIES.replace("conversation_to_paid_client", "conversation_to_meeting_booked+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client"), name: "Bliss", assignedAt: at(2) },
      { combinationKey: REPLY_BOOKING, name: "Reply Booking", assignedAt: at(3) },
      { combinationKey: "campaign:sales-cold-email-outreach|lead_found_to_conversation", name: "Robin", assignedAt: at(1) },
    ];
    const bliss = rows[1].combinationKey;
    const plan = planFunnelRenames(rows, new Set(["Robin"]), [bliss], () => null);
    // Bliss runs campaigns: it is named first and takes the plain name; Zenith takes the next one. Reply Booking stays.
    expect(plan).toEqual([
      { combinationKey: bliss, from: "Bliss", to: "Cold Email Replies" },
      { combinationKey: COLD_REPLIES, from: "Zenith", to: "Email Replies" },
    ]);
    expect(planFunnelRenames(rows.map((r) => ({ ...r, name: plan.find((p) => p.combinationKey === r.combinationKey)?.to ?? r.name })), new Set(["Robin"]), [], () => null)).toEqual([]);
  });
});
