import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { dynastyMembers, NO_MERGES, poolMergedDynasties, pooledDynastyOf, resolveDynastyMerges, sumOverMembers } from "./dynasty-merges.js";
import { dynastyMergesOf } from "./public-stats-clients.js";
import { rollUpLegEvidenceByDynasty } from "./fleet-leg-maturity.js";
import { poolLegAssignments, type LegAssignmentRow } from "./workflow-leg-assignments.js";

// The pilot pair: azalea absorbed into mebsuta on the reply pipe (TPL-DYNASTY-1021-WF).
const SURVIVOR = "sales-cold-email-outreach-mebsuta";
const ABSORBED = "sales-cold-email-outreach-azalea";
const OTHER = "sales-cold-email-outreach-keel";

function catalogue(merged: boolean) {
  return [
    { workflowSlug: `${SURVIVOR}-v4`, workflowDynastySlug: SURVIVOR, workflowDynastyName: "Mebsuta", status: "active", workflowDynastyStatus: "active" as const, mergedIntoDynastySlug: null },
    { workflowSlug: `${SURVIVOR}-v3`, workflowDynastySlug: SURVIVOR, workflowDynastyName: "Mebsuta", status: "deprecated", workflowDynastyStatus: "active" as const, mergedIntoDynastySlug: null },
    { workflowSlug: `${ABSORBED}-v8`, workflowDynastySlug: ABSORBED, workflowDynastyName: "Azalea", status: "active", workflowDynastyStatus: merged ? ("deprecated" as const) : ("active" as const), mergedIntoDynastySlug: merged ? SURVIVOR : null },
    { workflowSlug: `${ABSORBED}-v7`, workflowDynastySlug: ABSORBED, workflowDynastyName: "Azalea", status: "deprecated", workflowDynastyStatus: merged ? ("deprecated" as const) : ("active" as const), mergedIntoDynastySlug: merged ? SURVIVOR : null },
    { workflowSlug: `${OTHER}`, workflowDynastySlug: OTHER, workflowDynastyName: "Keel", status: "active", workflowDynastyStatus: "active" as const, mergedIntoDynastySlug: null },
  ];
}

const COSTS = [
  { dimensions: { workflowSlug: `${SURVIVOR}-v4` }, totalCostInUsdCents: "1000.5" },
  { dimensions: { workflowSlug: `${SURVIVOR}-v3` }, totalCostInUsdCents: "200" },
  { dimensions: { workflowSlug: `${ABSORBED}-v8` }, totalCostInUsdCents: "700.25" },
  { dimensions: { workflowSlug: `${ABSORBED}-v7` }, totalCostInUsdCents: "99.25" },
  { dimensions: { workflowSlug: OTHER }, totalCostInUsdCents: "50" },
];
const EMAILS = new Map<string, Record<string, number>>([
  [`${SURVIVOR}-v4`, { recipientsContacted: 300, recipientsClicked: 4, recipientsRepliesPositive: 3 }],
  [`${SURVIVOR}-v3`, { recipientsContacted: 100, recipientsClicked: 1, recipientsRepliesPositive: 1 }],
  [`${ABSORBED}-v8`, { recipientsContacted: 250, recipientsClicked: 2, recipientsRepliesPositive: 2 }],
  [`${ABSORBED}-v7`, { recipientsContacted: 50, recipientsClicked: 0, recipientsRepliesPositive: 1 }],
  [OTHER, { recipientsContacted: 20, recipientsClicked: 0, recipientsRepliesPositive: 0 }],
]);

function rollUp(merged: boolean) {
  const stated = catalogue(merged);
  return rollUpLegEvidenceByDynasty(poolMergedDynasties(stated, dynastyMergesOf(stated)), COSTS, EMAILS).byDynasty;
}

describe("merged dynasties pool their stats (TPL-DYNASTY-1021-FS)", () => {
  it("survivor after the merge = survivor before + absorbed before, on every figure, difference zero", () => {
    const before = rollUp(false);
    const after = rollUp(true);
    const s = before.get(SURVIVOR)!;
    const a = before.get(ABSORBED)!;
    expect(after.get(SURVIVOR)).toEqual({
      spentCents: s.spentCents + a.spentCents,
      contacted: s.contacted + a.contacted,
      clicks: s.clicks + a.clicks,
      replies: s.replies + a.replies,
    });
    expect(after.get(SURVIVOR)!.spentCents).toBe(2000);
    expect(after.has(ABSORBED)).toBe(false);
    // A dynasty outside the merge never moves.
    expect(after.get(OTHER)).toEqual(before.get(OTHER));
  });

  it("an un-merge (the record no longer states the pair) returns the original per-dynasty figures exactly", () => {
    const original = rollUp(false);
    rollUp(true);
    expect(rollUp(false)).toEqual(original);
  });

  it("no merge stated = the catalogue array itself, byte-identical", () => {
    const stated = catalogue(false);
    expect(poolMergedDynasties(stated, dynastyMergesOf(stated))).toBe(stated);
  });

  it("an absorbed version takes the survivor's slug and name, keeps its own status axes", () => {
    const stated = catalogue(true);
    const pooled = poolMergedDynasties(stated, dynastyMergesOf(stated));
    const v8 = pooled.find((w) => w.workflowSlug === `${ABSORBED}-v8`)!;
    expect(v8).toMatchObject({ workflowDynastySlug: SURVIVOR, workflowDynastyName: "Mebsuta", status: "active", workflowDynastyStatus: "deprecated" });
    // The stated catalogue is never mutated.
    expect(stated.find((w) => w.workflowSlug === `${ABSORBED}-v8`)!.workflowDynastySlug).toBe(ABSORBED);
  });

  it("resolves chains to the final survivor and refuses a contradiction", () => {
    const merges = resolveDynastyMerges([
      { absorbed: "a", survivor: "b" },
      { absorbed: "b", survivor: "c" },
    ]);
    expect(pooledDynastyOf("a", merges)).toBe("c");
    expect(dynastyMembers("c", merges)).toEqual(["c", "a", "b"]);
    expect(() => resolveDynastyMerges([{ absorbed: "a", survivor: "b" }, { absorbed: "a", survivor: "c" }])).toThrow(/both/);
    expect(() => resolveDynastyMerges([{ absorbed: "a", survivor: "b" }, { absorbed: "b", survivor: "a" }])).toThrow(/cycle/);
  });

  it("a producer-resolved dynasty read is asked once per member and summed per day", async () => {
    const merges = resolveDynastyMerges([{ absorbed: ABSORBED, survivor: SURVIVOR }]);
    const read = vi.fn(async (member: string) =>
      member === SURVIVOR ? new Map([["2026-10-20", 1.5], ["2026-10-21", 2]]) : new Map([["2026-10-21", 0.25]]),
    );
    const out = await sumOverMembers(SURVIVOR, merges, read, (a, b) => a + b);
    expect(read).toHaveBeenCalledTimes(2);
    expect([...out]).toEqual([["2026-10-20", 1.5], ["2026-10-21", 2.25]]);
    // Without a merge: the one original read, untouched.
    const single = vi.fn(async () => new Map([["2026-10-21", 9]]));
    expect([...(await sumOverMembers(SURVIVOR, NO_MERGES, single, (a, b) => a + b))]).toEqual([["2026-10-21", 9]]);
    expect(single).toHaveBeenCalledTimes(1);
  });
});

describe("leg assignments of a merged dynasty", () => {
  const row = (slug: string, state: "active" | "deprecated"): LegAssignmentRow => ({
    featureSlug: "sales-cold-email-outreach",
    legKey: "lead_found_to_conversation",
    workflowDynastySlug: slug,
    state,
    decidedBy: "test",
    decidedAt: "2026-10-21T00:00:00.000Z",
    note: null,
  });
  const merges = resolveDynastyMerges([{ absorbed: ABSORBED, survivor: SURVIVOR }]);

  it("the absorbed dynasty is no row of its own; the survivor's own row stands", () => {
    const out = poolLegAssignments([row(SURVIVOR, "active"), row(ABSORBED, "active")], merges);
    expect([...out.keys()]).toEqual([SURVIVOR]);
    expect(out.get(SURVIVOR)!.state).toBe("active");
  });

  it("a survivor with no row borrows its absorbed member's, so the pipe never loses its workflow", () => {
    const out = poolLegAssignments([row(ABSORBED, "active")], merges);
    expect(out.get(SURVIVOR)).toMatchObject({ workflowDynastySlug: SURVIVOR, state: "active" });
  });

  it("no merge = every stated row as is", () => {
    const rows = [row(SURVIVOR, "active"), row(ABSORBED, "deprecated")];
    expect([...poolLegAssignments(rows, NO_MERGES).values()]).toEqual(rows);
  });
});
