import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetWriterCatalogueForTest, readWriterModelAliases } from "./writer-catalogue-client.js";

// LLM-STATUS-PER-PIPE-1023 (owner 2026-10-23: « Il faut que la deprecation manuelle soit par pipe »): a writer alias's
// status is read ON ONE PIPE; GLM deprecated for Lead -> Website visit stays active on Lead -> Positive reply.
describe("readWriterModelAliases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetWriterCatalogueForTest();
  });

  it("asks content-generation for the status on the pipe, and holds each pipe apart", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "http://cg";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const visit = url.includes("legKey=lead_found_to_website_visit");
        return new Response(JSON.stringify({ models: [{ model: "glm-pro", provider: "zai", status: visit ? "deprecated" : "active" }] }), { status: 200 });
      }),
    );
    const visit = await readWriterModelAliases("sales-cold-email-outreach", "lead_found_to_website_visit");
    const reply = await readWriterModelAliases("sales-cold-email-outreach", "lead_found_to_conversation");
    expect(visit[0]!.status).toBe("deprecated");
    expect(reply[0]!.status).toBe("active");
    expect(urls).toEqual([
      "http://cg/internal/models?featureSlug=sales-cold-email-outreach&legKey=lead_found_to_website_visit",
      "http://cg/internal/models?featureSlug=sales-cold-email-outreach&legKey=lead_found_to_conversation",
    ]);
    // held per pipe: a second read of the same pipe asks nothing
    await readWriterModelAliases("sales-cold-email-outreach", "lead_found_to_conversation");
    expect(urls).toHaveLength(2);
  });
});
