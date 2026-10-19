import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { judgedVersionOf, legQuestion, livePipesOf, plan, templateTypesOf, type PerformedLeg } from "./one-leg-per-workflow.js";
import type { LegAssignmentRow } from "./workflow-leg-assignments.js";

const row = (featureSlug: string, legKey: string, workflowDynastySlug: string): LegAssignmentRow => ({
  featureSlug,
  legKey,
  workflowDynastySlug,
  state: "active",
  decidedBy: "workflow-service",
  decidedAt: "2026-10-12T00:00:00.000Z",
  note: null,
});
const CE = "sales-cold-email-outreach";
const REPLY = "lead_found_to_conversation";
const VISIT = "lead_found_to_website_visit";
const performedAll = (_f: string, legKey: string): PerformedLeg => ({ legKey, label: legKey });
const pick = (legKey: string, confidence = 0.95) => ({ legKey, confidence, probabilities: { [legKey]: confidence }, model: "jev" });

describe("ONE-LEG-PER-WORKFLOW-1019 plan: one leg, always, never forked (owner 2026-10-19)", () => {
  const base = { performed: performedAll, runnable: new Set<string>(), livePipes: new Set<string>(), judgedOn: new Map() };

  it("a reply template keeps the positive reply leg and comes off the website visit leg (Nobelium)", () => {
    const active = [row(CE, REPLY, "nobelium"), row(CE, VISIT, "nobelium"), row(CE, VISIT, "rampart"), row(CE, REPLY, "keel")];
    const [r] = plan({ ...base, active, runnable: new Set(["rampart", "keel"]), picks: new Map([["nobelium", pick(REPLY)]]) });
    expect(r.kept).toEqual([{ legKey: REPLY, reason: "template_type" }]);
    expect(r.removed).toEqual([{ legKey: VISIT, reason: "one_leg", emptiesPipe: false }]);
  });

  it("never stays doubled to spare a pipe: a workflow alone on its pipes keeps ONE and says which pipes empty (Zaurak)", () => {
    const F = "cold-whatsapp-outreach";
    const [r] = plan({ ...base, active: [row(F, REPLY, "zaurak"), row(F, VISIT, "zaurak")], runnable: new Set(["zaurak"]), picks: new Map([["zaurak", pick(REPLY)]]) });
    expect(r.kept).toEqual([{ legKey: REPLY, reason: "template_type" }]);
    expect(r.removed).toEqual([{ legKey: VISIT, reason: "one_leg", emptiesPipe: true }]);
  });

  it("keeps the leg a LIVE campaign would lose its only workflow on, over the template pick (Belenos, Doc Dinners' Form Callback)", () => {
    const F = "ai-instant-call";
    const FORM = "form_submitted_to_booking_call";
    const CALL = "conversation_to_booking_call";
    const [r] = plan({
      ...base,
      active: [row(F, CALL, "belenos"), row(F, FORM, "belenos"), row(F, CALL, "alsciaukat")],
      runnable: new Set(["belenos", "alsciaukat"]),
      livePipes: new Set([`${F}|${FORM}`, `${F}|${CALL}`]),
      picks: new Map([["belenos", pick(CALL)]]),
    });
    expect(r.kept).toEqual([{ legKey: FORM, reason: "live_campaign" }]);
    expect(r.removed).toEqual([{ legKey: CALL, reason: "one_leg", emptiesPipe: false }]);
  });

  it("several live pipes would stop: the template pick ranks them, every other leg still comes off", () => {
    const F = "ai-follow-up-email";
    const [r] = plan({
      ...base,
      active: [row(F, "a_to_b", "algenib"), row(F, "c_to_d", "algenib"), row(F, "e_to_f", "algenib")],
      runnable: new Set(["algenib"]),
      livePipes: new Set([`${F}|a_to_b`, `${F}|c_to_d`]),
      picks: new Map([["algenib", { legKey: "e_to_f", confidence: 0.5, probabilities: { e_to_f: 0.5, c_to_d: 0.3, a_to_b: 0.2 }, model: "jev" }]]),
    });
    expect(r.kept).toEqual([{ legKey: "c_to_d", reason: "live_campaign" }]);
    expect(r.removed.map((x) => x.legKey).sort()).toEqual(["a_to_b", "e_to_f"]);
  });

  it("a leg the channel no longer publishes comes off first, with no Jev question (Email Sending's retired Email sent leg)", () => {
    const F = "email-sending";
    const [r] = plan({
      ...base,
      active: [row(F, "start_to_conversation", "bubup"), row(F, "start_to_email_sent", "bubup")],
      performed: (_f, legKey) => (legKey === "start_to_email_sent" ? null : { legKey, label: legKey }),
      runnable: new Set(["bubup"]),
      picks: new Map(),
    });
    expect(r.removed).toEqual([{ legKey: "start_to_email_sent", reason: "leg_not_performed", emptiesPipe: true }]);
    expect(r.kept).toEqual([{ legKey: "start_to_conversation", reason: "only_performed_leg" }]);
  });

  it("a workflow on one leg is not resolved", () => {
    expect(plan({ ...base, active: [row(CE, REPLY, "solo")], picks: new Map() })).toEqual([]);
  });

  it("reads live pipes off ongoing campaigns only, in the stored spelling", () => {
    const pipes = livePipesOf([
      { status: "ongoing", featureSlug: CE, legKey: "start_to_conversation" },
      { status: "stopped", featureSlug: CE, legKey: VISIT },
      { status: "ongoing", featureSlug: "ai-instant-call", legKey: "form_submitted_to_booking_call" },
    ]);
    expect([...pipes].sort()).toEqual(["ai-instant-call|form_submitted_to_booking_call", `${CE}|${REPLY}`]);
  });
});

describe("what the pick is judged on", () => {
  it("reads the template type(s) workflow-service's own rule reads (literal input mapping, else config body)", () => {
    const dag = {
      nodes: [
        { id: "a", type: "http.call", config: { service: "content-generation", path: "/generate" }, inputMapping: { "body.type": "cold-email-v58" } },
        { id: "b", type: "http.call", config: { service: "content-generation", path: "/generate", body: { type: "blind-discovery-email-v47" } }, inputMapping: { "body.type": "$ref:x" } },
        { id: "c", type: "http.call", config: { service: "lead", path: "/generate", body: { type: "nope" } } },
      ],
    };
    expect(templateTypesOf(dag)).toEqual(["blind-discovery-email-v47", "cold-email-v58"]);
    expect(templateTypesOf({})).toEqual([]);
  });

  it("judges the active version, else the latest", () => {
    const v = (version: number, versionActive: boolean) => ({ workflowSlug: `n-v${version}`, workflowDynastySlug: "n", version, versionActive, description: null, dag: {} });
    expect(judgedVersionOf([v(1, false), v(3, false), v(2, true)], "n")?.version).toBe(2);
    expect(judgedVersionOf([v(1, false), v(3, false)], "n")?.version).toBe(3);
    expect(judgedVersionOf([], "n")).toBeNull();
  });

  it("asks Jev a choice among the workflow's own legs, on the template type only", () => {
    const q = legQuestion([{ legKey: REPLY, label: "Lead found -> Positive reply" }, { legKey: VISIT, label: "Lead found -> Website visit" }]);
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual([REPLY, VISIT]);
    expect(q.instructions).toContain("template type only");
  });
});
