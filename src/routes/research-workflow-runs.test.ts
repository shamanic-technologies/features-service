import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { readWorkflowRuns, __resetWorkflowRunsCache, WORKFLOW_RUNS_REUSE_MS } from "./research-sends.js";
import { computeResearchShared } from "./research.js";

process.env.RUNS_SERVICE_URL = "http://runs";
process.env.RUNS_SERVICE_API_KEY = "k";

// BOX-DB-LOAD-1027-FEATURES: one refresh cycle = the builds that read the catalogue's last runs (billed mature, billed
// flash, the vendor-cost twin, and the build the server re-asked while the previous one was still reading), each over
// the same pipes: the reply pipe, the visit pipe and two other pipes, three orgs each.
const ORGS = ["org-a", "org-b", "org-c"];
const PIPES = ["reply", "visit", "other-1", "other-2"].map((pipe) =>
  ORGS.flatMap((orgId) => [1, 2].map((n) => ({ orgId, campaignId: `${pipe}-${orgId}-c${n}` }))),
);
const BUILDS: Array<"user" | "actual"> = ["user", "user", "actual", "user"];
const dynastyOf = (slug: string) => slug.replace(/-v\d+$/, "");

function runsOf(url: string) {
  const ids = new URL(url).searchParams.get("campaignIds")!.split(",");
  return ids.flatMap((id, i) => [
    { workflowSlug: `wf-${id}-v2`, status: "completed", startedAt: `2026-10-2${i}T10:00:00.000Z`, completedAt: `2026-10-2${i}T10:05:00.000Z`, totalCostInUsdCents: "123.4" },
    { workflowSlug: null, status: "completed", startedAt: `2026-10-2${i}T11:00:00.000Z`, completedAt: null, totalCostInUsdCents: "5" },
    { workflowSlug: `wf-${id}-v3`, status: "running", startedAt: `2026-10-2${i}T12:00:00.000Z`, completedAt: null },
  ]);
}

let calls: string[];
beforeEach(() => {
  __resetWorkflowRunsCache();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ runs: runsOf(url) }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function cycle(resetBetweenBuilds: boolean) {
  const out = [];
  for (const basis of BUILDS) {
    if (resetBetweenBuilds) __resetWorkflowRunsCache();
    out.push(await Promise.all(PIPES.map((p) => readWorkflowRuns(p, dynastyOf, basis))));
  }
  return out;
}

describe("readWorkflowRuns: one runs-service read per (org, campaign set) per reuse window", () => {
  it("a refresh cycle asks runs-service 12 times instead of 48, and every build lists the same runs", async () => {
    const before = await cycle(true);
    const beforeCalls = calls.length;
    __resetWorkflowRunsCache();
    calls = [];
    const after = await cycle(false);
    expect(beforeCalls).toBe(BUILDS.length * PIPES.length * ORGS.length); // 48: one per build x pipe x org
    expect(calls.length).toBe(PIPES.length * ORGS.length); // 12: one per pipe x org
    expect(after).toEqual(before);
    // Same request as before the cache: org header, campaign set, task, limit, subtree cost.
    const q = new URL(calls[0]).searchParams;
    expect([q.get("taskName"), q.get("limit"), q.get("include")]).toEqual(["execute-workflow", "200", "subtreeCost"]);
  });

  it("serves the same rows as an uncached read: status, start, end, billed cost (null on the vendor basis), newest first", async () => {
    const runs = await readWorkflowRuns(PIPES[0], dynastyOf, "user");
    expect(runs.length).toBe(ORGS.length * 2 * 2);
    expect(runs[0]).toMatchObject({ status: "running", completedAt: null, costUsd: null });
    expect(runs.find((r) => r.workflowSlug.endsWith("-v2"))).toMatchObject({ dynasty: expect.stringMatching(/^wf-/), costUsd: 1.234, completedAt: expect.any(String) });
    expect(runs.map((r) => r.startedAt)).toEqual([...runs.map((r) => r.startedAt)].sort().reverse());
    const actual = await readWorkflowRuns(PIPES[0], dynastyOf, "actual");
    expect(actual.every((r) => r.costUsd === null)).toBe(true);
    expect(actual.map(({ costUsd: _c, ...r }) => r)).toEqual(runs.map(({ costUsd: _c, ...r }) => r));
  });

  it("concurrent builds share the read in flight; a list older than the reuse window is read again", async () => {
    await Promise.all([readWorkflowRuns(PIPES[0], dynastyOf, "user"), readWorkflowRuns(PIPES[0], dynastyOf, "actual")]);
    expect(calls.length).toBe(ORGS.length);
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + WORKFLOW_RUNS_REUSE_MS + 1);
    await readWorkflowRuns(PIPES[0], dynastyOf, "user");
    expect(calls.length).toBe(2 * ORGS.length);
  });

  it("a failed read lists that org's runs as none and is asked again on the next build", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response("boom", { status: 503 });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readWorkflowRuns(PIPES[0], dynastyOf, "user")).toEqual([]);
    expect(await readWorkflowRuns(PIPES[0], dynastyOf, "user")).toEqual([]);
    expect(calls.length).toBe(2 * ORGS.length);
  });
});

describe("computeResearchShared: one Research compute per (basis, view) at a time", () => {
  it("an ask arriving while the same build runs joins it; once done, the next ask computes again", async () => {
    const releases: Array<(v: unknown) => void> = [];
    const compute = vi.fn(() => new Promise((r) => releases.push(r))) as never;
    const a = computeResearchShared("user", "mature", compute);
    const b = computeResearchShared("user", "mature", compute);
    const c = computeResearchShared("user", "flash", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(b).toBe(a);
    releases.forEach((r) => r({ file: {} }));
    await Promise.all([a, c]);
    computeResearchShared("user", "mature", compute);
    expect(compute).toHaveBeenCalledTimes(3);
    releases.forEach((r) => r({ file: {} }));
  });
});
