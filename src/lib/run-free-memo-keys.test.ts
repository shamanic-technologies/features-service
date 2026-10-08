import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withInteractiveReads } from "./lead-copy.js";
import { __resetInteractiveMemo } from "./interactive-memo.js";
import { __resetSharedReads } from "./fetch-retry.js";
import { fetchWorkflowContentModelsSoft } from "./workflow-content-model-client.js";
import { fetchActiveAudienceAvailabilitySoft } from "./human-client.js";

// The gateway mints a NEW x-run-id per request, so a reuse keyed on the request's headers never hits
// across a page's polls. These two slow-moving reads are reused on (org, …) alone.
describe("request-path reads reused across requests with different run ids", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.DOWNSTREAM_READ_SHARE_MS = "3000";
    process.env.WORKFLOW_SERVICE_URL = "http://wf";
    process.env.WORKFLOW_SERVICE_API_KEY = "wk";
    process.env.HUMAN_SERVICE_URL = "http://human";
    process.env.HUMAN_SERVICE_API_KEY = "hk";
    __resetInteractiveMemo();
    __resetSharedReads();
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (url.startsWith("http://wf/")) {
        return new Response(JSON.stringify({ workflows: [{ workflowDynastySlug: "keel", version: 2, status: "active", contentModel: "sonnet" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ audiences: [{ id: "a1", availableToContactCount: 7 }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    process.env.DOWNSTREAM_READ_SHARE_MS = "0";
    vi.unstubAllGlobals();
  });

  it("reads the workflow catalogue once for two requests of one org", async () => {
    const a = await withInteractiveReads(() => fetchWorkflowContentModelsSoft("f", { orgId: "o1", userId: "u", runId: "run-1" }));
    const b = await withInteractiveReads(() => fetchWorkflowContentModelsSoft("f", { orgId: "o1", userId: "u", runId: "run-2" }));
    expect(a).toEqual(new Map([["keel", "sonnet"]]));
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await withInteractiveReads(() => fetchWorkflowContentModelsSoft("f", { orgId: "o2", userId: "u", runId: "run-3" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads a brand's active audiences once for two requests of one org", async () => {
    const a = await withInteractiveReads(() => fetchActiveAudienceAvailabilitySoft("b1", { orgId: "o1", userId: "u", runId: "run-1" }));
    const b = await withInteractiveReads(() => fetchActiveAudienceAvailabilitySoft("b1", { orgId: "o1", userId: "u", runId: "run-2" }));
    expect(a).toEqual(new Map([["a1", 7]]));
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("outside an interactive view every call reads (no reuse)", async () => {
    await fetchWorkflowContentModelsSoft("f", { orgId: "o1", userId: "u", runId: "run-1" });
    await fetchWorkflowContentModelsSoft("f", { orgId: "o1", userId: "u", runId: "run-2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
