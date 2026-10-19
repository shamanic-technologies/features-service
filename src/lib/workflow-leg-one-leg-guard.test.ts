import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ONE LEG AT A TIME (owner 2026-10-19, ONE-LEG-PER-WORKFLOW-1019): every write that would put a workflow ACTIVE on a
 * second leg is refused, named, before anything is written. A fake transaction answers the two reads the writers make
 * in order: the row being written (`existing`), then the dynasty's active rows on OTHER legs (`others`).
 */
const state = vi.hoisted(() => ({
  existing: [] as any[],
  others: [] as any[],
  selects: 0,
  inserts: [] as any[],
  locks: 0,
}));

vi.mock("../db/index.js", () => {
  const whereResult = () => {
    const n = state.selects++;
    const rows = n === 0 ? state.existing : state.others;
    const p: any = Promise.resolve(rows);
    p.for = () => Promise.resolve(rows);
    return p;
  };
  const tx = {
    execute: async () => {
      state.locks++;
      return [];
    },
    select: () => ({ from: () => ({ where: whereResult }) }),
    insert: () => ({
      values: (v: any) => {
        state.inserts.push(v);
        const row = { ...v, decidedAt: new Date("2026-10-19T00:00:00Z"), note: v.note ?? null };
        const done: any = Promise.resolve([row]);
        done.onConflictDoUpdate = () => ({ returning: async () => [row] });
        done.onConflictDoNothing = () => ({ returning: async () => [row] });
        return done;
      },
    }),
  };
  return { db: { transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) }, sql: {} };
});

import { registerLegAssignment, setLegAssignment, WorkflowOnAnotherLegError } from "./workflow-leg-assignments.js";

const nobeliumOnReplies = { featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_conversation" };

beforeEach(() => {
  state.existing = [];
  state.others = [];
  state.selects = 0;
  state.inserts = [];
  state.locks = 0;
});

describe("a workflow is active on one leg at a time (owner 2026-10-19)", () => {
  it("refuses to make a workflow active on a SECOND leg, naming the leg it holds, and writes nothing", async () => {
    state.others = [nobeliumOnReplies];
    const write = setLegAssignment({
      featureSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_website_visit",
      workflowDynastySlug: "sales-cold-email-outreach-nobelium",
      state: "active",
      decidedBy: "staff",
    });
    await expect(write).rejects.toBeInstanceOf(WorkflowOnAnotherLegError);
    await expect(write).rejects.toMatchObject({ reason: "workflow_on_another_leg", activeOn: [nobeliumOnReplies] });
    expect(state.locks).toBe(1);
    expect(state.inserts).toEqual([]);
  });

  it("refuses to REGISTER a workflow on a second pipe (workflow-service at creation)", async () => {
    state.others = [nobeliumOnReplies];
    const write = registerLegAssignment({
      featureSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_website_visit",
      workflowDynastySlug: "sales-cold-email-outreach-nobelium",
      registeredBy: "workflow-service",
    });
    await expect(write).rejects.toMatchObject({ reason: "workflow_on_another_leg" });
    expect(state.inserts).toEqual([]);
  });

  it("assigns a workflow active on no other leg", async () => {
    const { assignment } = await setLegAssignment({
      featureSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_conversation",
      workflowDynastySlug: "sales-cold-email-outreach-nobelium",
      state: "active",
      decidedBy: "staff",
    });
    expect(assignment.state).toBe("active");
    expect(state.inserts).toHaveLength(2); // the row + its history row
  });

  it("deprecating never asks: coming off a leg cannot make a second one", async () => {
    state.existing = [{ state: "active" }];
    state.others = [nobeliumOnReplies];
    await setLegAssignment({
      featureSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_website_visit",
      workflowDynastySlug: "sales-cold-email-outreach-nobelium",
      state: "deprecated",
      decidedBy: "ONE-LEG-PER-WORKFLOW-1019",
    });
    expect(state.locks).toBe(0);
    expect(state.inserts.map((i) => i.toState ?? i.state)).toEqual(["deprecated", "deprecated"]);
  });

  it("re-confirming a leg it is already active on is not a second leg", async () => {
    state.existing = [{ state: "active" }];
    state.others = [nobeliumOnReplies];
    await setLegAssignment({
      featureSlug: "sales-cold-email-outreach",
      legKey: "lead_found_to_website_visit",
      workflowDynastySlug: "sales-cold-email-outreach-nobelium",
      state: "active",
      decidedBy: "staff",
    });
    expect(state.locks).toBe(0);
  });
});
