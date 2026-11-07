/**
 * BOX-LOAD-1107: a read its caller marks `holdOutsideViewMs` is asked once per window OUTSIDE a view compute (fleet builds,
 * loops, plain routes): concurrent askers share it, a failure is never held, the window ends it, a `fresh` caller is never
 * held. Prod 2026-11-07: workflow-service's catalogue was re-read ~1,036 times a minute by the agent catalogue model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, __resetSharedReads } from "./fetch-retry.js";
import { fetchStatedPublicWorkflows } from "./public-stats-clients.js";

describe("hold outside a view (BOX-LOAD-1107)", () => {
  let calls: string[] = [];
  let status = 200;
  beforeEach(() => {
    process.env.RUNS_READ_SHARE_MS = "30000";
    process.env.WORKFLOW_SERVICE_URL = "http://workflow";
    process.env.WORKFLOW_SERVICE_API_KEY = "k";
    __resetSharedReads();
    calls = [];
    status = 200;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ n: calls.length, workflows: [{ workflowSlug: `w${calls.length}` }] }), { status });
    });
  });
  afterEach(() => {
    process.env.RUNS_READ_SHARE_MS = "0";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks a held read once across concurrent and later askers inside the window, each reading its own body", async () => {
    const read = async () => (await fetchWithRetry("http://workflow/public/workflows?featureSlugs=a", { headers: { "x-api-key": "k" } }, { holdOutsideViewMs: 30_000 })).json();
    const [a, b] = await Promise.all([read(), read()]);
    const c = await read();
    expect(calls).toHaveLength(1);
    expect([a, b, c].map((x) => (x as { n: number }).n)).toEqual([1, 1, 1]);
  });

  it("re-asks once the window passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const read = () => fetchWithRetry("http://workflow/p", { headers: { "x-api-key": "k" } }, { holdOutsideViewMs: 30_000 });
    await read();
    vi.setSystemTime(Date.now() + 30_001);
    await read();
    expect(calls).toHaveLength(2);
  });

  it("never holds a failed answer", async () => {
    status = 502;
    const read = () => fetchWithRetry("http://workflow/p", { headers: { "x-api-key": "k" } }, { holdOutsideViewMs: 30_000 });
    await read();
    status = 200;
    expect((await read()).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("never holds a read that did not ask for it, nor when the kill switch is off", async () => {
    await fetchWithRetry("http://workflow/p", { headers: { "x-api-key": "k" } });
    await fetchWithRetry("http://workflow/p", { headers: { "x-api-key": "k" } });
    process.env.RUNS_READ_SHARE_MS = "0";
    await fetchWithRetry("http://workflow/q", {}, { holdOutsideViewMs: 30_000 });
    await fetchWithRetry("http://workflow/q", {}, { holdOutsideViewMs: 30_000 });
    expect(calls).toHaveLength(4);
  });

  it("the stated catalogue is held 30 s outside a view; a fresh (write-path) read always asks", async () => {
    const a = await fetchStatedPublicWorkflows("sales-cold-email-outreach", "all");
    const b = await fetchStatedPublicWorkflows("sales-cold-email-outreach", "all");
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
    await fetchStatedPublicWorkflows("sales-cold-email-outreach", "all", true);
    expect(calls).toHaveLength(2);
  });
});
