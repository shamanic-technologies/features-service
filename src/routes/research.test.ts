import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { campaignOutputsOf, clientCostRowsOf, fetchDatedSpend, partEstimateGroupsOf, replayBucketsOf, spendWindows, workflowEstimateGroupsOf } from "./research.js";
import { readLegSpendTotal } from "./research-sends.js";

describe("research dated spend windows", () => {
  it("covers every month to now, the cutoff's month split exactly at the cutoff", () => {
    const w = spendWindows(new Date("2026-10-18T15:00:00Z"), "2026-09-27T00:00:00.000Z");
    expect(w[0]!.from).toBe("2026-01-01T00:00:00.000Z");
    const sep = w.filter((x) => x.month === "2026-09");
    expect(sep).toEqual([
      { month: "2026-09", from: "2026-09-01T00:00:00.000Z", to: "2026-09-27T00:00:00.000Z", beforeCutoff: true },
      { month: "2026-09", from: "2026-09-27T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", beforeCutoff: false },
    ]);
    expect(w.find((x) => x.month === "2026-08")!.beforeCutoff).toBe(true);
    expect(w.find((x) => x.month === "2026-10")!.beforeCutoff).toBe(false);
    // contiguous, no gap, no overlap
    for (let i = 1; i < w.length; i++) expect(w[i]!.from).toBe(w[i - 1]!.to);
  });
  it("a leg that waits for nothing puts every window in the mature cohort", () => {
    expect(spendWindows(new Date("2026-03-05T00:00:00Z"), null).every((x) => x.beforeCutoff)).toBe(true);
  });
});

// runs-service's no-auth public aggregation ignores the run-start window and answers LIFETIME (prod 2026-10-23: every
// month read $9,026). Only the org-scoped aggregation honours it, so the Research reads must take that one.
describe("research spend reads honour the run-start window (RESEARCH-DATED-SPEND-1023)", () => {
  const lifetimeCents: Record<string, number> = { orgA: 10_000, orgB: 5_000 };
  const monthCents = (org: string, from: string | null) => (from === null ? lifetimeCents[org]! : from.startsWith("2026-02") ? lifetimeCents[org]! : 0);
  const calls: Array<{ path: string; org: string | null; from: string | null; to: string | null }> = [];
  function stubRuns() {
    calls.length = 0;
    process.env.RUNS_SERVICE_URL = "http://runs";
    process.env.RUNS_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const u = new URL(url);
      const org = init?.headers?.["x-org-id"] ?? null;
      const from = u.searchParams.get("startedAfter");
      const to = u.searchParams.get("startedBefore");
      calls.push({ path: u.pathname, org, from, to });
      // the public route: lifetime whatever the window; the org route: the window's own spend
      const cents = u.pathname === "/v1/stats/public/costs" || !org ? 15_000 : monthCents(org, from);
      return new Response(JSON.stringify({ groups: cents ? [{ dimensions: { workflowSlug: "wf-1" }, totalCostInUsdCents: String(cents), runCount: 1 }] : [] }), { status: 200 });
    }));
  }
  const campaigns = [
    { campaignId: "c1", orgId: "orgA" },
    { campaignId: "c2", orgId: "orgB" },
  ];

  it("dated spend: each month carries only its own runs, never the lifetime total, read per org", async () => {
    stubRuns();
    const rows = await fetchDatedSpend("sales-cold-email-outreach", campaigns, "gross", null, new Date("2026-04-10T00:00:00Z"));
    expect(calls.every((c) => c.path === "/v1/stats/costs" && c.org !== null && c.from !== null)).toBe(true);
    const byMonth = new Map<string, number>();
    for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.spentUsd);
    expect(Object.fromEntries(byMonth)).toEqual({ "2026-02": 150 });
    expect(rows.filter((r) => r.month === "2026-02").map((r) => r.orgId).sort()).toEqual(["orgA", "orgB"]);
    vi.unstubAllGlobals();
  });

  it("leg spend before the cutoff is read per org with the cutoff bound", async () => {
    stubRuns();
    await readLegSpendTotal("sales-cold-email-outreach", campaigns, "gross", "2026-03-01T00:00:00.000Z");
    expect(calls.map((c) => [c.path, c.org, c.to])).toEqual([
      ["/v1/stats/costs", "orgA", "2026-02-28T23:59:59.999999Z"],
      ["/v1/stats/costs", "orgB", "2026-02-28T23:59:59.999999Z"],
    ]);
    vi.unstubAllGlobals();
  });
});

describe("workflowEstimateGroupsOf (COST-ACCOUNTING-1023-P3)", () => {
  it("pools every version on its dynasty, ages each serve day, leaves out an undated bucket, takes the billed spend", () => {
    const g = workflowEstimateGroupsOf(
      [
        { workflowSlug: "keel-v2", servedDay: "2026-10-22", contacted: 10, positiveReplies: 1 },
        { workflowSlug: "keel-v3", servedDay: "2026-10-01", contacted: 30, positiveReplies: 2 },
        { workflowSlug: "keel-v3", servedDay: "", contacted: 5, positiveReplies: 1 },
      ],
      new Map([["keel-v2", "keel"], ["keel-v3", "keel"]]),
      [{ workflowDynastySlug: "keel", basis: "mature", spentUsd: 3, figuresByView: { flash: { spentUsd: { value: 12.5 } } } }],
      (d) => d.toUpperCase(),
      new Date("2026-10-23T15:00:00Z"),
    );
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: "keel", label: "KEEL", outcomes: 3, spendUsd: 12.5 });
    expect(g[0]!.slices).toEqual([{ contacted: 10, ageDays: 1.5 }, { contacted: 30, ageDays: 22.5 }]);
  });
});

describe("campaignOutputsOf (COST-ACCOUNTING-1023-P2)", () => {
  it("a campaign's output is its stated leg's catalogue to-step, either outbound spelling; no stated leg = none", () => {
    const { outputOf, pipeOutputs } = campaignOutputsOf(
      [
        { id: "c1", featureSlug: "sales-cold-email-outreach", legKey: "start_to_conversation" },
        { id: "c2", featureSlug: "sales-cold-email-outreach", legKey: "lead_found_to_website_visit" },
        { id: "c3", featureSlug: "sales-cold-email-outreach" },
      ],
      [{ slug: "sales-cold-email-outreach", stepTransitions: [{ legKey: "lead_found_to_conversation", to: { key: "conversation" } }, { legKey: "lead_found_to_website_visit", to: { key: "website_visit" } }] }],
    );
    expect(outputOf("c1")).toBe("conversation");
    expect(outputOf("c2")).toBe("website_visit");
    expect(outputOf("c3")).toBeNull();
    expect([...pipeOutputs].sort()).toEqual(["conversation", "website_visit"]);
  });
});

describe("clientCostRowsOf (COST-ACCOUNTING-1023-P4)", () => {
  it("one row per client with a ledger figure or a positive reply, today's spend and replies summed per org", () => {
    const unit = { outcomeKey: "conversation", produced: 2, byProducts: 0, unitCostUsd: 5, ownUnitCostUsd: 5, stages: [], unpricedInputs: [] };
    const rows = clientCostRowsOf(
      new Map([["o1", { units: new Map([["conversation", unit]]) }]]),
      new Map([["o1", 50]]),
      [
        { orgId: "o1", positiveReplies: 1 },
        { orgId: "o1", positiveReplies: 1 },
        { orgId: "o2", positiveReplies: 3 },
        { orgId: "o3", positiveReplies: 0 },
      ],
      [
        { orgId: "o1", spentUsd: 4 },
        { orgId: "o1", spentUsd: 6 },
        { orgId: "o2", spentUsd: 9 },
      ],
      (o) => o.toUpperCase(),
    );
    expect(rows.map((r) => r.orgId).sort()).toEqual(["o1", "o2"]);
    expect(rows.find((r) => r.orgId === "o1")).toMatchObject({ label: "O1", coveragePct: 50, todaySpendUsd: 10, todayReplies: 2, ledger: unit });
    expect(rows.find((r) => r.orgId === "o2")).toMatchObject({ ledger: null, coveragePct: null, todaySpendUsd: 9, todayReplies: 3 });
  });
});

describe("partEstimateGroupsOf + replayBucketsOf (PERF-ESTIMATE-DISCUSS-1024)", () => {
  const persons = [
    { workflowSlug: "keel-v2", servedDay: "2026-10-01", contacted: 30, positiveReplies: 1, tpl: "blind", positiveReplyDay: "2026-10-03" },
    { workflowSlug: "keel-v2", servedDay: "2026-10-01", contacted: 10, positiveReplies: 0, tpl: "named", positiveReplyDay: null },
    { workflowSlug: "keel-v2", servedDay: "2026-10-02", contacted: 10, positiveReplies: 0, tpl: null, positiveReplyDay: null },
    { workflowSlug: "keel-v2", servedDay: "", contacted: 50, positiveReplies: 0, tpl: "blind", positiveReplyDay: null },
  ];
  const partOf = (p: (typeof persons)[number]) => (p.tpl ? { key: p.tpl, label: p.tpl.toUpperCase() } : null);
  it("groups by part, shares each workflow's spend on its people, states the people with no writer", () => {
    const { groups, peopleLeftOut } = partEstimateGroupsOf(
      persons,
      partOf,
      new Map([["keel-v2", "keel"]]),
      [{ workflowDynastySlug: "keel", basis: "flash", spentUsd: 100 }],
      new Date("2026-10-23T15:00:00Z"),
    );
    expect(peopleLeftOut).toBe(10);
    // $100 over the dynasty's 100 people (undated ones included): $1 a person
    expect(groups.map((g) => [g.key, g.label, g.outcomes, g.spendUsd])).toEqual([
      ["blind", "BLIND", 1, 30],
      ["named", "NAMED", 0, 10],
    ]);
  });
  it("replay buckets carry the reply day, served people only", () => {
    expect(replayBucketsOf(persons, partOf)).toEqual([
      { key: "blind", label: "BLIND", servedDay: "2026-10-01", contacted: 30, positiveReplies: 1, positiveReplyDay: "2026-10-03" },
      { key: "named", label: "NAMED", servedDay: "2026-10-01", contacted: 10, positiveReplies: 0, positiveReplyDay: null },
    ]);
  });
});
