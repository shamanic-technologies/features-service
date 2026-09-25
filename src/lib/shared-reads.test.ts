/**
 * Inside an interactive view compute, identical GETs are asked once and reused briefly; a failed
 * answer, a different header set, or a read outside a view compute is never shared.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, __resetSharedReads } from "./fetch-retry.js";
import { withLiveLeadCopy } from "./lead-copy.js";

describe("shared downstream reads", () => {
  let calls: string[] = [];
  let status = 200;
  beforeEach(() => {
    process.env.DOWNSTREAM_READ_SHARE_MS = "3000";
    __resetSharedReads();
    calls = [];
    status = 200;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push(`${String(input)} ${JSON.stringify((init as RequestInit)?.headers ?? {})}`);
      return new Response(JSON.stringify({ n: calls.length }), { status });
    });
  });
  afterEach(() => {
    process.env.DOWNSTREAM_READ_SHARE_MS = "0";
    vi.restoreAllMocks();
  });

  it("asks an identical GET once across concurrent view computes, each reading its own body", async () => {
    const read = () => withLiveLeadCopy(async () => (await fetchWithRetry("http://runs/x", { headers: { "x-org-id": "o1" } })).json());
    const [a, b] = await Promise.all([read(), read()]);
    const c = await read();
    expect(calls).toHaveLength(1);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(c).toEqual({ n: 1 });
  });

  it("never shares across different headers (another org is another question)", async () => {
    await withLiveLeadCopy(() => fetchWithRetry("http://runs/x", { headers: { "x-org-id": "o1" } }));
    await withLiveLeadCopy(() => fetchWithRetry("http://runs/x", { headers: { "x-org-id": "o2" } }));
    expect(calls).toHaveLength(2);
  });

  it("never reuses a failed answer, never shares a POST, never shares outside a view compute", async () => {
    status = 502;
    await withLiveLeadCopy(() => fetchWithRetry("http://runs/x"));
    await withLiveLeadCopy(() => fetchWithRetry("http://runs/x"));
    status = 200;
    await withLiveLeadCopy(() => fetchWithRetry("http://runs/y", { method: "POST", body: "{}" }));
    await withLiveLeadCopy(() => fetchWithRetry("http://runs/y", { method: "POST", body: "{}" }));
    await fetchWithRetry("http://runs/z");
    await fetchWithRetry("http://runs/z");
    expect(calls).toHaveLength(6);
  });

  it("answers a lifetime runs cost read as past + today, re-asking the past half only when it ages", async () => {
    vi.restoreAllMocks();
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = new URL(String(input));
      asked.push(u.searchParams.has("startedBefore") ? "past" : "today");
      const total = u.searchParams.has("startedBefore") ? "10.0000000000" : "2.5000000000";
      return new Response(JSON.stringify({ groups: [{ dimensions: { workflowSlug: "w" }, totalCostInUsdCents: total, runCount: 1 }] }), { status: 200 });
    });
    const read = () =>
      withLiveLeadCopy(async () => (await fetchWithRetry("http://runs:8080/v1/stats/costs?groupBy=workflowSlug", { headers: { "x-org-id": "o" } })).json());
    process.env.DOWNSTREAM_READ_SHARE_MS = "1";
    expect(await read()).toEqual({ groups: [{ dimensions: { workflowSlug: "w" }, totalCostInUsdCents: "12.5000000000", runCount: 2 }] });
    await new Promise((r) => setTimeout(r, 5));
    await read();
    // The today half is read again; the past half (reused 30s) is not.
    expect(asked).toEqual(["past", "today", "today"]);
  });
});
