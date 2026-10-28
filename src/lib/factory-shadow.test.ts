import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCatalogueModel, type CatalogueInputs, type PipeMeasurement, type PlayInput } from "./agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";
import {
  briefHashOf,
  briefQuestion,
  chainsToTarget,
  evalBriefOf,
  judgingNeed,
  monitoringVerdict,
  orgDayCountsOf,
  pipesToJudge,
  planCampaign,
  playOptionsOf,
  playsSignatureOf,
  STALE_AFTER_MS,
  ShadowPlanError,
} from "./factory-shadow.js";

// FACTORY-P1-BRIEF-JUDGE-SHADOW-PLAN: the brief judge's re-judge triggers and the shadow plan on the seeded catalogue.

const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
const mature = (c: number, r: number): PipeMeasurement => ({ basis: "mature", costPerOutcomeUsd: c, conversionRatePct: r, workflowDynastySlug: "w" });

const COLD = "sales-cold-email-outreach|lead_found_to_conversation";
const play = (strategyId: string, name: string, description: string, measurement: PipeMeasurement | null): PlayInput => ({
  strategyId,
  strategyName: name,
  strategyDescription: description,
  measurement,
  allowedActiveWorkflowCount: 1,
  allowedActiveDynasties: ["w"],
  excludedDynasties: [],
});

const inputs = (over: Partial<CatalogueInputs> = {}): CatalogueInputs => ({
  channels,
  publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
  declaredSteps: [],
  measurements: new Map([
    [COLD, mature(40, 1)],
    ["ai-meeting-booking|conversation_to_meeting_booked", mature(2, 30)],
    ["lead-sourcing|start_to_lead_found", mature(0.5, 100)],
    ["sourcing-apollo-cold-filters|start_to_lead_found", mature(0.2, 100)],
  ]),
  lifetimeRevenueUsd: 3000,
  ...over,
});

const NO_STEPS = { stated: false, steps: null } as const;
const PROACTIVE_RUNNING = "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach+conversation_to_paid_client";
const REACTIVE_RUNNING = "conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client";

describe("the shadow plan (proactive: from Start to the Target)", () => {
  const model = buildCatalogueModel(inputs());

  it("cuts every catalogue chain from Start at the Target", () => {
    const chains = chainsToTarget(model, "proactive", null, "conversation");
    expect(chains).toContainEqual(["start_to_lead_found", "lead_found_to_conversation"]);
    for (const c of chains) expect(c[c.length - 1].endsWith("_to_conversation")).toBe(true);
  });

  it("prices the running funnel and the best-ROI line to the Target on one basis (each pipe's own cost x outcomes needed)", () => {
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p).toMatchObject({ target: "conversation", targetSource: "campaign", mode: "proactive", startStep: null, planDiffers: true });
    // Running: 100 leads at $0.50 + one positive reply at $40 = $90; value of a positive reply $150 (5% x $3,000).
    expect(p.running).toMatchObject({ reachesTarget: true, funnelId: "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach" });
    if (!p.running.reachesTarget) throw new Error("unreachable");
    expect(p.running.figures).toMatchObject({ costPerTargetUsd: 90, roi: 1.67, targetValueUsd: 150 });
    // Shadow: Apollo Cold Filters finds the 100 leads at $0.20: $60, 2.5x.
    expect(p.shadow?.funnelId).toBe("start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_conversation@sales-cold-email-outreach");
    expect(p.shadow?.figures).toMatchObject({ costPerTargetUsd: 60, roi: 2.5 });
    expect(p.shadow?.line).toBe("Start → [Apollo Cold Filters] → Lead → [Sales Cold Email Outreach] → Positive reply");
  });

  it("the Target defaults to the running funnel's last step when campaign-service states none yet", () => {
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: null, mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p.target).toBe("paid_client");
    expect(p.targetSource).toBe("funnel_last_step");
  });

  it("sets aside a line through a step the offer does not have", () => {
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null }, new Map(), { stated: true, steps: ["conversation"] }, "fleet");
    expect(p.candidatesSetAside).toBe(0);
    const none = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "meeting_booked", mode: null, triggerId: null }, new Map(), { stated: true, steps: ["conversation"] }, "fleet");
    expect(none.candidatesSetAside).toBeGreaterThan(0);
  });

  it("a running funnel that never reaches the Target is said so, never priced on another step", () => {
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "meeting_booked", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p.running).toEqual({ funnelId: expect.any(String), reachesTarget: false, unavailableReason: "running_funnel_does_not_reach_target" });
    expect(p.planDiffers).toBeNull();
  });

  it("a funnel the catalogue does not know fails loud with its reason", () => {
    expect(() => planCampaign(model, { salesFunnelId: "nope", target: null, mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet")).toThrow(ShadowPlanError);
  });
});

describe("the shadow plan (reactive: from the trigger's step to the Target)", () => {
  const model = buildCatalogueModel(inputs());

  it("starts at the trigger's step and prices the value the line ADDS over it", () => {
    const p = planCampaign(model, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p).toMatchObject({ mode: "reactive", triggerId: "positive_reply_received", startStep: "conversation" });
    if (!p.running.reachesTarget) throw new Error("unreachable");
    // $2 per meeting booked; (value $450 − the replier's $150) / $2 = 150x.
    expect(p.running.figures).toMatchObject({ costPerTargetUsd: 2, roi: 150 });
    expect(p.shadow?.line.startsWith("Positive reply → ")).toBe(true);
    expect(p.shadow?.line.endsWith("→ Meeting booked")).toBe(true);
    expect(p.planDiffers).toBe(false);
  });

  it("campaign-service's own statement of the head wins over the running funnel's", () => {
    const p = planCampaign(model, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: "reactive", triggerId: "positive_reply_received" }, new Map(), NO_STEPS, "fleet");
    expect(p.triggerId).toBe("positive_reply_received");
    for (const chain of chainsToTarget(model, "reactive", "conversation", "meeting_booked")) expect(chain[0].startsWith("conversation_to_")).toBe(true);
  });
});

describe("the brief's picks narrow the plan to the play chosen", () => {
  const model = buildCatalogueModel(
    inputs({
      plays: new Map([[COLD, { default: play("everyone", "Everyone", "Email every lead found.", mature(40, 1)), others: [play("valid-only", "Valid only", "Email only addresses verified valid.", mature(30, 1))] }]]),
    }),
  );
  const VALID = `${COLD}~valid-only`;

  it("offers the default play first, then every runnable play", () => {
    const options = playOptionsOf(model, model.pipes.get(COLD)!);
    expect(options.map((o) => [o.id, o.isDefault])).toEqual([[COLD, true], [VALID, false]]);
    const q = briefQuestion(options);
    expect(q.type).toBe("choice");
    expect(q.criteria.o0.startsWith("DEFAULT. ")).toBe(true);
    expect(q.criteria.o1).toBe("Valid only: Email only addresses verified valid.");
  });

  it("the cheaper play wins unconstrained; the brief's pick of the default keeps it out", () => {
    const free = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(free.shadow?.legs[1]).toMatchObject({ pipeId: VALID, strategyName: "Valid only" });
    const picked = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null }, new Map([[COLD, COLD]]), NO_STEPS, "fleet");
    expect(picked.shadow?.legs[1]).toMatchObject({ pipeId: COLD, strategyName: "Everyone" });
  });

  it("judges every pipe of the running funnel and of the lines to the Target that has plays to choose from", () => {
    const pipes = pipesToJudge(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null });
    expect(pipes.map((p) => p.id)).toEqual([COLD]);
  });

  it("the eval brief names the strategy each pipe runs today", () => {
    const { brief, expected } = evalBriefOf(model, `start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach~valid-only+conversation_to_paid_client`);
    expect(brief).toContain("Valid only. Email only addresses verified valid.");
    expect(expected.get(COLD)).toBe(VALID);
  });
});

describe("the brief judge: judged once, re-judged when the brief or the plays move", () => {
  const options = [
    { id: "p", isDefault: true, name: "Default", description: "everyone" },
    { id: "p~v", isDefault: false, name: "Valid", description: "valid only" },
  ];
  const brief = briefHashOf("Only verified emails.");

  it("an empty brief is the default play, no Jev call", () => {
    expect(briefHashOf("   ")).toBeNull();
    expect(judgingNeed(null, null, options)).toEqual({ kind: "default", source: "empty_brief" });
  });

  it("a pipe with one play needs no judge", () => {
    expect(judgingNeed(null, brief, options.slice(0, 1))).toEqual({ kind: "default", source: "single_play" });
  });

  it("asks once, then reuses the stored verdict", () => {
    expect(judgingNeed(null, brief, options)).toEqual({ kind: "ask" });
    expect(judgingNeed({ briefHash: brief, playsSignature: playsSignatureOf(options) }, brief, options)).toEqual({ kind: "stored" });
  });

  it("re-judges when the brief changes", () => {
    expect(judgingNeed({ briefHash: brief, playsSignature: playsSignatureOf(options) }, briefHashOf("Every email, catch-all included."), options)).toEqual({ kind: "ask" });
  });

  it("re-judges when a play is added, retired or reworded", () => {
    const stored = { briefHash: brief, playsSignature: playsSignatureOf(options) };
    expect(judgingNeed(stored, brief, [...options, { id: "p~c", isDefault: false, name: "C", description: "catch-all" }])).toEqual({ kind: "ask" });
    expect(judgingNeed(stored, brief, [options[0], { ...options[1], description: "valid addresses only" }])).toEqual({ kind: "ask" });
  });
});

describe("Monitoring", () => {
  it("counts per org the campaigns whose plan or pick differs, and the failures", () => {
    expect(
      orgDayCountsOf([
        { orgId: "b", status: "ok", planDiffers: true, pickDiffers: false },
        { orgId: "a", status: "ok", planDiffers: false, pickDiffers: true },
        { orgId: "a", status: "judge_failed", planDiffers: true, pickDiffers: true },
        { orgId: "a", status: "plan_failed", planDiffers: null, pickDiffers: false },
      ]),
    ).toEqual([
      { orgId: "a", campaigns: 3, planDiffers: 1, pickDiffers: 2, differs: 2, judgeFailed: 1, planFailed: 1 },
      { orgId: "b", campaigns: 1, planDiffers: 1, pickDiffers: 0, differs: 1, judgeFailed: 0, planFailed: 0 },
    ]);
  });

  it("is red when a judge or a plan failed, when the pass is stale, or when none ever ran", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(monitoringVerdict({ sweptAt: now.toISOString(), judgeFailed: 0, planFailed: 0 }, now)).toEqual({ red: false, reasons: [] });
    expect(monitoringVerdict({ sweptAt: now.toISOString(), judgeFailed: 1, planFailed: 0 }, now).reasons).toEqual(["judge_failed"]);
    expect(monitoringVerdict({ sweptAt: now.toISOString(), judgeFailed: 0, planFailed: 2 }, now).reasons).toEqual(["plan_failed"]);
    expect(monitoringVerdict({ sweptAt: new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString(), judgeFailed: 0, planFailed: 0 }, now).reasons).toEqual(["last_pass_stale"]);
    expect(monitoringVerdict({ sweptAt: null, judgeFailed: 0, planFailed: 0 }, now).reasons).toEqual(["never_computed"]);
  });
});
