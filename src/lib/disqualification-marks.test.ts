import { describe, it, expect, vi, afterEach } from "vitest";

vi.unmock("./disqualification-marks.js");
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchDisqualifiedLeadIds, applyDisqualifiedMarks, deferLoud } = await import("./disqualification-marks.js");
const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

describe("fetchDisqualifiedLeadIds — lead-service's Disqualified MARK, read whole, fail loud", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks the brand's (and offer's) marks and returns their lead ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ brandId: "b1", offerId: "o1", total: 2, leads: [{ id: "lc1", leadId: "l1" }, { id: "lc2", leadId: "l2" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect([...(await fetchDisqualifiedLeadIds("b1", "o1", HEADERS))]).toEqual(["l1", "l2"]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://lead:3000/orgs/leads/disqualifications?brandId=b1&offerId=o1");
  });

  it("a failed or malformed read throws, never an empty set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(fetchDisqualifiedLeadIds("b1", null, HEADERS)).rejects.toThrow(/500/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ total: 0 }), { status: 200 })));
    await expect(fetchDisqualifiedLeadIds("b1", null, HEADERS)).rejects.toThrow(/no leads array/);
  });
});

describe("applyDisqualifiedMarks / deferLoud", () => {
  it("marks exactly the listed leads", () => {
    const persons = [{ leadId: "a" }, { leadId: "b" }] as never as Array<{ leadId: string; disqualified?: boolean }>;
    applyDisqualifiedMarks(persons as never, new Set(["b"]));
    expect(persons.map((p) => p.disqualified ?? false)).toEqual([false, true]);
  });

  it("a deferred failure throws where it is awaited", async () => {
    await expect(deferLoud(Promise.reject(new Error("down")))()).rejects.toThrow("down");
    expect(await deferLoud(Promise.resolve(3))()).toBe(3);
  });
});
