import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { judgedVersionOf, legQuestion, plan, templateTypesOf, type PerformedLeg } from "./one-leg-per-workflow.js";
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
const pick = (legKey: string, confidence = 0.95) => ({ legKey, confidence, model: "jev" });

describe("ONE-LEG-PER-WORKFLOW-1019 plan", () => {
  it("a reply template keeps the positive reply leg and comes off the website visit leg (Nobelium)", () => {
    const active = [row(CE, REPLY, "nobelium"), row(CE, VISIT, "nobelium"), row(CE, VISIT, "rampart"), row(CE, REPLY, "keel")];
    const [r] = plan({
      active,
      performed: performedAll,
      runnable: new Set(["rampart", "keel"]),
      picks: new Map([["nobelium", pick(REPLY)]]),
      judgedOn: new Map([["nobelium", { templateTypes: ["blind-discovery-email-v33"], description: null }]]),
    });
    expect(r.kept).toEqual([{ legKey: REPLY, reason: "template_type" }]);
    expect(r.removed).toEqual([{ legKey: VISIT, reason: "template_type" }]);
  });

  it("never empties a pipe: a workflow alone on a pipe stays there, named", () => {
    const F = "cold-whatsapp-outreach";
    const [r] = plan({
      active: [row(F, REPLY, "zaurak"), row(F, VISIT, "zaurak")],
      performed: performedAll,
      runnable: new Set(["zaurak"]),
      picks: new Map([["zaurak", pick(REPLY)]]),
      judgedOn: new Map(),
    });
    expect(r.kept).toEqual([
      { legKey: REPLY, reason: "template_type" },
      { legKey: VISIT, reason: "would_empty_pipe" },
    ]);
    expect(r.removed).toEqual([]);
  });

  it("a runnable workflow never leaves a pipe whose other workflows cannot run", () => {
    const [r] = plan({
      active: [row(CE, REPLY, "azalea"), row(CE, VISIT, "azalea"), row(CE, VISIT, "allegro")],
      performed: performedAll,
      runnable: new Set(["azalea"]),
      picks: new Map([["azalea", pick(REPLY)]]),
      judgedOn: new Map(),
    });
    expect(r.kept.map((k) => k.reason)).toEqual(["template_type", "would_empty_pipe"]);
  });

  it("each resolution sees the pipes as the previous one left them (two workflows never both leave)", () => {
    const res = plan({
      active: [row(CE, REPLY, "a"), row(CE, VISIT, "a"), row(CE, REPLY, "b"), row(CE, VISIT, "b")],
      performed: performedAll,
      runnable: new Set(),
      picks: new Map([["a", pick(REPLY)], ["b", pick(REPLY)]]),
      judgedOn: new Map(),
    });
    expect(res[0].removed).toEqual([{ legKey: VISIT, reason: "template_type" }]);
    expect(res[1].kept).toContainEqual({ legKey: VISIT, reason: "would_empty_pipe" });
  });

  it("a leg the channel no longer performs comes off first, with no Jev question (Email Sending's retired Email sent leg)", () => {
    const F = "email-sending";
    const [r] = plan({
      active: [row(F, "start_to_conversation", "bubup"), row(F, "start_to_email_sent", "bubup")],
      performed: (_f, legKey) => (legKey === "start_to_email_sent" ? null : { legKey, label: legKey }),
      runnable: new Set(["bubup"]),
      picks: new Map(),
      judgedOn: new Map(),
    });
    expect(r.removed).toEqual([{ legKey: "start_to_email_sent", reason: "leg_not_performed" }]);
    expect(r.kept).toEqual([{ legKey: "start_to_conversation", reason: "only_performed_leg" }]);
  });

  it("an unsure Jev moves nothing", () => {
    const [r] = plan({
      active: [row(CE, REPLY, "x"), row(CE, VISIT, "x"), row(CE, VISIT, "y"), row(CE, REPLY, "y2")],
      performed: performedAll,
      runnable: new Set(),
      picks: new Map([["x", pick(VISIT, 0.4)]]),
      judgedOn: new Map(),
    });
    expect(r.removed).toEqual([]);
    expect(r.kept.every((k) => k.reason === "jev_unsure")).toBe(true);
  });

  it("a workflow on one leg is not resolved", () => {
    expect(plan({ active: [row(CE, REPLY, "solo")], performed: performedAll, runnable: new Set(), picks: new Map(), judgedOn: new Map() })).toEqual([]);
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
