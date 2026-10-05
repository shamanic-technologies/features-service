import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWorkflowContentModelsSoft } from "./workflow-content-model-client.js";

afterEach(() => vi.restoreAllMocks());

describe("fetchWorkflowContentModelsSoft", () => {
  it("an identity with no user or run reads no model alias and calls nobody (workflow-service would 400)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await fetchWorkflowContentModelsSoft("sales-cold-email-outreach", { orgId: "org-1", userId: "", runId: "" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
