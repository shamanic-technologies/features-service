import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { buildCatalogueModel, funnelById, pathById, type CatalogueInputs, type PipeMeasurement, type PlayInput } from "./agent-catalogue.js";
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
  pipeCandidatesOf,
  pipesToJudge,
  planChangeOf,
  shadowStateOf,
  briefNamedChannels,
  offerStepsOfCampaign,
  planCampaign,
  playOptionsOf,
  playsSignatureOf,
  STALE_AFTER_MS,
  ShadowPlanError,
  triggerCanHead,
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
    expect(p).toMatchObject({ target: "conversation", targetSource: "campaign", mode: "proactive", startStep: null, rankedOn: "roi", planDiffers: true });
    // Running: 100 leads at $0.50 + one positive reply at $40 = $90; value of a positive reply $150 (5% x $3,000).
    // The running funnel names itself whole (what campaign-service runs); the comparison is on the line to the Target.
    expect(p.running).toMatchObject({ reachesTarget: true, funnelId: PROACTIVE_RUNNING, lineId: "start_to_lead_found@lead-sourcing+lead_found_to_conversation@sales-cold-email-outreach" });
    if (!p.running.reachesTarget) throw new Error("unreachable");
    expect(p.running.figures).toMatchObject({ costPerTargetUsd: 90, roi: 1.67, targetValueUsd: 150 });
    // Shadow: Apollo Cold Filters finds the 100 leads at $0.20: $60, 2.5x.
    expect(p.shadow?.lineId).toBe("start_to_lead_found@sourcing-apollo-cold-filters+lead_found_to_conversation@sales-cold-email-outreach");
    // The plan names a CATALOGUE funnel campaign-service can run (past the Target to Paid client).
    expect(funnelById(model, p.shadow!.funnelId)?.id).toBe(p.shadow!.funnelId);
    expect(p.shadow!.funnelId.startsWith(`${p.shadow!.lineId}+`)).toBe(true);
    expect(p.shadow?.figures).toMatchObject({ costPerTargetUsd: 60, roi: 2.5 });
    expect(p.shadow?.line).toBe("Start → [Apollo Cold Filters] → Lead → [Sales Cold Email Outreach] → Positive reply");
  });

  it("a proactive plan starts on a proactive pipe, never on a pipe waiting for a trigger", () => {
    const model = buildCatalogueModel(inputs());
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "paid_client", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(funnelById(model, p.shadow!.funnelId)!.legs[0].pipe!.mode).toBe("proactive");
  });

  it("the Target defaults to the running funnel's last step when campaign-service states none yet", () => {
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: null, mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p.target).toBe("paid_client");
    expect(p.targetSource).toBe("funnel_last_step");
  });

  it("sets aside a line through a step the offer does not have", () => {
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null }, new Map(), { stated: true, steps: ["conversation"] }, "fleet");
    // Only funnels walking Lead found, Positive reply and Paid client remain (the whole funnel must fit the offer).
    expect(p.shadow).not.toBeNull();
    expect(pathById(model, funnelById(model, p.shadow!.funnelId)!.pathId)!.steps.every((s) => ["lead_found", "conversation", "paid_client"].includes(s))).toBe(true);
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

  it("never proposes a trigger-headed line the catalogue does not serve (campaign-service read unknown_sales_funnel)", () => {
    const LEGS = ["conversation_to_meeting_booked", "meeting_booked_to_meeting_attended", "meeting_attended_to_paid_client"];
    const undeclared = buildCatalogueModel(inputs());
    const none = planCampaign(undeclared, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: "reactive", triggerId: "lead_event" }, new Map(), NO_STEPS, "fleet");
    // No pipe answers Lead event and no Lead event head is declared: nothing to propose, never an invented head.
    expect(none.shadow).toBeNull();
    expect(none.shadowUnavailableReason).toBe("no_runnable_line_to_target");
    const declared = buildCatalogueModel(inputs({ triggerHeadedPaths: [{ triggerId: "lead_event", legKeys: LEGS }] }));
    const p = planCampaign(declared, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: "reactive", triggerId: "lead_event" }, new Map(), NO_STEPS, "fleet");
    expect(p.shadow?.funnelId.startsWith("trigger:lead_event+conversation_to_meeting_booked@")).toBe(true);
    expect(funnelById(declared, p.shadow!.funnelId)?.id).toBe(p.shadow!.funnelId);
  });

  it("campaign-service's own statement of the head wins over the running funnel's", () => {
    const p = planCampaign(model, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: "reactive", triggerId: "positive_reply_received" }, new Map(), NO_STEPS, "fleet");
    expect(p.triggerId).toBe("positive_reply_received");
    for (const chain of chainsToTarget(model, "reactive", "conversation", "meeting_booked")) expect(chain[0].startsWith("conversation_to_")).toBe(true);
  });
});

describe("who may start a reactive line, and an unvalued Target", () => {
  it("a trigger heads a proactive pipe only from its own step; Lead event from any step; a step-less trigger never", () => {
    const model = buildCatalogueModel(inputs());
    expect(triggerCanHead(model, "positive_reply_received", "conversation")).toBe(true);
    expect(triggerCanHead(model, "positive_reply_received", null)).toBe(false);
    expect(triggerCanHead(model, "follow_up_due", null)).toBe(false);
    expect(triggerCanHead(model, "lead_event", null)).toBe(true);
  });

  it("every line through a pipe with no price yet names that pipe (a catalogue gap, not a search failure)", () => {
    const model = buildCatalogueModel(inputs());
    // A pipe that ran with no outcome, no seeded default, no benchmark (Form Booking, Lead Proposal in prod 2026-10-28).
    for (const pipe of model.pipes.values()) if (pipe.fromStep === "conversation" && pipe.operatedBy === "platform") pipe.expectedCost = null;
    const p = planCampaign(model, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p.shadow).toBeNull();
    // Two lines from a positive reply to a meeting: AI Meeting Booking directly, or AI Instant Call then a booking.
    expect(p.shadowUnavailableReason?.startsWith("pipe_unpriced:")).toBe(true);
    expect(p.shadowUnavailableReason).toContain("ai-meeting-booking|conversation_to_meeting_booked");
    expect(p.unpricedPipes.map((u) => u.pipeId)).toContain("ai-meeting-booking|conversation_to_meeting_booked");
    expect(p.shadowUnavailableDetail).toContain("AI Meeting Booking (Positive reply to Meeting booked)");
    expect(p.shadowUnavailableDetail).toContain("no price yet");
  });

  it("a Target with no value (after Paid client) still gets the cheapest line per Target, ROI null", () => {
    const model = buildCatalogueModel(inputs());
    model.steps.set("conversation", { ...model.steps.get("conversation")!, valueUsd: null });
    const p = planCampaign(model, { salesFunnelId: PROACTIVE_RUNNING, target: "conversation", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet");
    expect(p.rankedOn).toBe("cost_per_target");
    expect(p.shadow?.figures).toMatchObject({ costPerTargetUsd: 60, roi: null, unavailableReason: "target_unvalued" });
    if (!p.running.reachesTarget) throw new Error("unreachable");
    expect(p.running.figures).toMatchObject({ costPerTargetUsd: 90, roi: null });
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
      { orgId: "a", campaigns: 3, planDiffers: 1, pickDiffers: 2, differs: 2, judgeFailed: 1, planFailed: 1, notYet: 0 },
      { orgId: "b", campaigns: 1, planDiffers: 1, pickDiffers: 0, differs: 1, judgeFailed: 0, planFailed: 0, notYet: 0 },
    ]);
  });

  it("a plan only waiting on a first price is NOT YET, never counted as failed (owner 2026-10-29: red only when broken)", () => {
    expect(orgDayCountsOf([{ orgId: "a", status: "plan_failed", planDiffers: null, pickDiffers: false, state: "not_yet" }])).toEqual([
      { orgId: "a", campaigns: 1, planDiffers: 0, pickDiffers: 0, differs: 0, judgeFailed: 0, planFailed: 0, notYet: 1 },
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

describe("Monitoring: problems apart from not-yet (owner 2026-10-29)", () => {
  const unpriced = [{ pipeId: "threads-post|start_to_post_published", channelName: "Threads posts", fromStep: null, toStep: "post_published", lines: 1 }];
  const waiting = { shadow: null, shadowUnavailableReason: "pipe_unpriced:threads-post|start_to_post_published", shadowUnavailableDetail: "Every line ...", unpricedPipes: unpriced };

  it("a line waiting on a pipe that never spent is not yet, with the pipe by name", () => {
    expect(shadowStateOf({ status: "plan_failed", failure: waiting.shadowUnavailableReason, followsPlan: false, plan: waiting })).toEqual({
      state: "not_yet",
      stateReason: "pipe_unpriced:threads-post|start_to_post_published",
      stateDetail: "Waiting for a first price: Threads posts has never run.",
    });
    expect(shadowStateOf({ status: "plan_failed", failure: "no_priced_line_to_target", plan: { ...waiting, shadowUnavailableReason: "no_priced_line_to_target", unpricedPipes: [] } }).state).toBe("not_yet");
  });

  it("the same on a campaign that FOLLOWS its plan is a problem: it cannot run", () => {
    const s = shadowStateOf({ status: "plan_failed", failure: "x", followsPlan: true, plan: { ...waiting, shadowUnavailableReason: "no_runnable_line_to_target", shadowUnavailableDetail: "No pipe we run today reaches Signup from Start." } });
    expect(s.state).toBe("problem");
    expect(s.stateReason).toBe("follows_plan_without_plan:no_runnable_line_to_target");
  });

  it("a judge failure, an unreadable campaign are problems; a priced plan is ok; an only line unpriced is not yet", () => {
    expect(shadowStateOf({ status: "judge_failed", failure: "chat 502", plan: null }).state).toBe("problem");
    expect(shadowStateOf({ status: "plan_failed", failure: "running_funnel_unknown", plan: null }).state).toBe("problem");
    expect(shadowStateOf({ status: "ok", failure: null, plan: { ...waiting, shadow: {} as never, shadowUnavailableReason: null, unpricedPipes: [] } }).state).toBe("ok");
    expect(shadowStateOf({ status: "ok", failure: null, plan: { ...waiting, shadow: {} as never, shadowUnavailableReason: null, shadowPickedOn: "only_line" } }).state).toBe("not_yet");
  });
});

describe("what would change: only the legs that differ, by name, with both lines' figures", () => {
  const leg = (legKey: string, pipeId: string | null, channelName: string | null, strategyName: string | null = null) => ({ legKey, pipeId, channelSlug: null, channelName, playId: null, strategyName });
  const figures = (cost: number | null, roi: number | null, basis: "measured" | "default" | null) => ({ costPerTargetUsd: cost, roi, basis, unavailableReason: null, targetValueUsd: 100, legs: [] });
  const head = leg("start_to_lead_found", "lead-sourcing|start_to_lead_found", "Lead Sourcing", "Valid only");
  const plan = {
    planDiffers: true,
    running: {
      reachesTarget: true as const,
      funnelId: "r",
      lineId: "r",
      line: "",
      legs: [head, leg("conversation_to_meeting_booked", "your-team-meeting-booking|x", "Your Team Meeting Booking"), leg("meeting_booked_to_meeting_attended", "your-team-meeting-attendance|x", "Your Team Meeting Attendance"), leg("meeting_attended_to_paid_client", "your-team-closing-calls|x", "Your Team Closing Calls")],
      figures: figures(120, 2.5, "measured"),
    },
    shadow: { funnelId: "s", lineId: "s", line: "", legs: [head, leg("conversation_to_paid_client", "your-team-reply-closing|x", "Your Team Reply Closing")], figures: figures(80, 3.75, "default") },
  };

  it("cuts the common head and tail, names each pipe, and serves both lines' $ per Target and ROI with their basis", () => {
    const c = planChangeOf(plan)!;
    expect(c.running.text).toBe("Your Team Meeting Booking → Your Team Meeting Attendance → Your Team Closing Calls");
    expect(c.best.text).toBe("Your Team Reply Closing");
    expect(c.running).toMatchObject({ costPerTargetUsd: 120, roi: 2.5, basis: "measured", inputsBasis: "measured" });
    expect(c.best).toMatchObject({ costPerTargetUsd: 80, roi: 3.75, basis: "expected", inputsBasis: "default" });
  });

  it("a play is named with its strategy; no change when the plan does not differ", () => {
    const p2 = { ...plan, shadow: { ...plan.shadow, legs: [leg("start_to_lead_found", "lead-sourcing|start_to_lead_found~x", "Lead Sourcing", "Catch-all"), ...plan.running.legs.slice(1)] } };
    expect(planChangeOf(p2)!.best.text).toBe("Lead Sourcing: Catch-all");
    expect(planChangeOf(p2)!.running.text).toBe("Lead Sourcing: Valid only");
    expect(planChangeOf({ ...plan, planDiffers: false })).toBeNull();
  });
});

describe("the only runnable line is the plan even before its pipe has a price (FACTORY-P2)", () => {
  it("one line, an unpriced pipe on it: it is the shadow line, picked on `only_line`, its pipe listed", () => {
    const model = buildCatalogueModel(inputs());
    for (const pipe of model.pipes.values()) if (pipe.fromStep === "conversation" && pipe.operatedBy === "platform") pipe.expectedCost = null;
    const p = planCampaign(model, { salesFunnelId: REACTIVE_RUNNING, target: "meeting_booked", mode: null, triggerId: null }, new Map(), NO_STEPS, "fleet", new Set(["ai-instant-call|conversation_to_booking_call"]));
    // Left: AI Meeting Booking (unpriced) and the client's own team (no plan of ours).
    expect(p.candidatesPriced).toBe(2);
    expect(p.shadow!.legs[0].pipeId).toBe("ai-meeting-booking|conversation_to_meeting_booked");
    expect(p.shadow).not.toBeNull();
    expect(p.shadowPickedOn).toBe("only_line");
    expect(p.shadowUnavailableReason).toBeNull();
    expect(p.unpricedPipes.map((u) => u.pipeId)).toContain("ai-meeting-booking|conversation_to_meeting_booked");
  });

  it("the pipe judge never asks about a pipe that cannot run (no workflow of ours)", () => {
    const model = buildCatalogueModel(inputs());
    const ids = pipeCandidatesOf(model, { salesFunnelId: PROACTIVE_RUNNING, target: "paid_client", mode: null, triggerId: null }).map((p) => p.id);
    for (const id of ids) expect(model.pipes.get(id)!.published && model.pipes.get(id)!.operatedBy === "platform").toBe(true);
    const notRunnable = [...model.pipes.values()].filter((p) => p.operatedBy === "platform" && !p.managed && !p.hasWorkflow).map((p) => p.id);
    expect(notRunnable.length).toBeGreaterThan(0);
    for (const id of notRunnable) expect(ids).not.toContain(id);
  });
});

describe("a channel the brief NAMES stays in the plan on its leg (owner 2026-10-29, API Email Meetings)", () => {
  const model = buildCatalogueModel(inputs());
  const frame = { salesFunnelId: REACTIVE_RUNNING, target: "paid_client", mode: null, triggerId: null } as const;
  const slugs = (p: ReturnType<typeof planCampaign>) => p.shadow!.legs.map((l) => l.channelSlug);

  it("without a named channel the best line skips an expensive AI Meeting Booking; named, it stays", () => {
    // AI Meeting Booking made dear: another line to Paid client wins on ROI unless the brief names it.
    const amb = model.pipes.get("ai-meeting-booking|conversation_to_meeting_booked")!;
    amb.expectedCost = { costPerOutcomeUsd: 5000, source: "workflow", basis: "measured" };
    const free = planCampaign(model, frame, new Map(), NO_STEPS, "fleet");
    expect(slugs(free)).not.toContain("ai-meeting-booking");
    const named = planCampaign(model, frame, new Map(), NO_STEPS, "fleet", new Set(), new Set(["ai-meeting-booking"]));
    expect(slugs(named)).toContain("ai-meeting-booking");
    expect(named.briefNamedChannels).toEqual(["ai-meeting-booking"]);
  });

  it("a brief names channels only when it rules some out: the kept ones (Jev) are the named ones", () => {
    const v = (pipeId: string, excluded: boolean | null, source: string | null = "jev") => ({ pipeId, excluded, source });
    expect(briefNamedChannels(model, [v(COLD, false), v("ai-meeting-booking|conversation_to_meeting_booked", false)])).toEqual(new Set());
    expect(briefNamedChannels(model, [v(COLD, false), v("ai-meeting-booking|conversation_to_meeting_booked", false), v("lead-sourcing|start_to_lead_found", true), v("sourcing-apollo-cold-filters|start_to_lead_found", null, null)])).toEqual(
      new Set(["sales-cold-email-outreach", "ai-meeting-booking"]),
    );
  });
});

describe("the offer has the steps its campaign was born on and runs (owner 2026-10-29, API Email Meetings)", () => {
  const model = buildCatalogueModel(inputs());
  it("a stated offer gains the steps of the campaign's own funnels; an unstated one stays unstated", () => {
    const stated = { stated: true, steps: ["conversation", "paid_client"] };
    const out = offerStepsOfCampaign(model, stated, [REACTIVE_RUNNING, null]);
    expect(new Set(out.steps)).toEqual(new Set(["conversation", "paid_client", "meeting_booked", "meeting_attended"]));
    expect(offerStepsOfCampaign(model, NO_STEPS, [REACTIVE_RUNNING])).toBe(NO_STEPS);
  });

  it("so the line through the channel the brief names is no longer set aside", () => {
    const frame = { salesFunnelId: REACTIVE_RUNNING, target: "paid_client", mode: null, triggerId: null } as const;
    const offer = { stated: true, steps: ["conversation", "paid_client"] };
    const named = new Set(["ai-meeting-booking"]);
    const before = planCampaign(model, frame, new Map(), offer, "fleet", new Set(), named);
    expect((before.shadow?.legs ?? []).map((l) => l.channelSlug)).not.toContain("ai-meeting-booking");
    const after = planCampaign(model, frame, new Map(), offerStepsOfCampaign(model, offer, [REACTIVE_RUNNING]), "fleet", new Set(), named);
    expect(after.shadow!.legs.map((l) => l.channelSlug)).toContain("ai-meeting-booking");
  });
});
