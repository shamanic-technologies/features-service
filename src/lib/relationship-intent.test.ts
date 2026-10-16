import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.unmock("./relationship-intent.js");
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchBrandIntent } = await import("./relationship-intent.js");

const answer = (body: unknown, status = 200) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("fetchBrandIntent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads every writer with both tags, emails lower-cased, on the org's identity", async () => {
    const spy = answer({
      brandId: "b1",
      count: 1,
      people: [{ humanId: "h1", name: "A", emails: [" Admin@X.com "], phones: [], lastInboundAt: "2026-10-15T00:00:00Z", lead: { state: "yes" }, wantsBusiness: { state: "yes" } }],
    });
    const people = await fetchBrandIntent("b1", { orgId: "org-1" });
    expect(people).toEqual([{ humanId: "h1", emails: ["admin@x.com"], lastInboundAt: "2026-10-15T00:00:00Z", leadState: "yes", wantsBusinessState: "yes" }]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://lead:3000/internal/brands/b1/relationships/intent");
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("org-1");
  });

  it("fails loud on a non-200 and on an unknown state (never an empty Hot)", async () => {
    answer({ error: "Not found" }, 404);
    await expect(fetchBrandIntent("b1", { orgId: "org-1" })).rejects.toThrow(/404/);
    answer({ people: [{ humanId: "h1", emails: [], lastInboundAt: null, lead: { state: "maybe" }, wantsBusiness: { state: null } }] });
    await expect(fetchBrandIntent("b1", { orgId: "org-1" })).rejects.toThrow(/lead.state "maybe"/);
  });
});
