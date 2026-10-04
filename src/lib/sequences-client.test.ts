import { describe, it, expect, vi, afterEach } from "vitest";

process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "email-key";

const { fetchSequencesByDay, fetchBroadcastQueuedEmails } = await import("./sequences-client.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

function dayGroup(key: string, contacted: number): Record<string, unknown> {
  return { key, broadcast: { recipientStats: { contacted } } };
}

describe("fetchSequencesByDay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps groupBy=day contacted into a SignalSeries: ascending days, zero-count dropped, total = sum, undatedCount 0", async () => {
    let seenUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      return new Response(
        JSON.stringify({ groups: [dayGroup("2026-07-01", 34), dayGroup("2026-06-30", 12), dayGroup("2026-06-29", 0)] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await fetchSequencesByDay("brand-1", undefined, "sales-cold-email-outreach", HEADERS);

    expect(res).toEqual({
      total: 46,
      daily: [
        { date: "2026-06-30", count: 12 },
        { date: "2026-07-01", count: 34 },
      ],
      undatedCount: 0,
    });
    // Queries the broadcast day series scoped to brand + feature, in UTC.
    expect(seenUrl).toContain("/orgs/stats");
    expect(seenUrl).toContain("groupBy=day");
    expect(seenUrl).toContain("type=broadcast");
    expect(seenUrl).toContain("brandId=brand-1");
    expect(seenUrl).toContain("featureSlugs=sales-cold-email-outreach");
    expect(seenUrl).toContain("timezone=UTC");
  });

  it("passes campaignId when scoped to a campaign", async () => {
    let seenUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      return new Response(JSON.stringify({ groups: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await fetchSequencesByDay("brand-1", "camp-9", "sales-cold-email-outreach", HEADERS);
    expect(res).toEqual({ total: 0, daily: [], undatedCount: 0 });
    expect(seenUrl).toContain("campaignId=camp-9");
  });

  it("throws on non-OK response (caller degrades to null)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("boom", { status: 500, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchSequencesByDay("brand-1", undefined, "f", HEADERS)).rejects.toThrow(/daily broadcast failed \(500\)/);
  });

  it("throws when a day group is missing a numeric contacted (fail loud, no silent 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ groups: [{ key: "2026-07-01", broadcast: { recipientStats: {} } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(fetchSequencesByDay("brand-1", undefined, "f", HEADERS)).rejects.toThrow(/missing numeric recipientStats.contacted/);
  });

  it("throws when the response has no groups array", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchSequencesByDay("brand-1", undefined, "f", HEADERS)).rejects.toThrow(/no groups array/);
  });
});

describe("fetchBroadcastQueuedEmails", () => {
  afterEach(() => vi.restoreAllMocks());

  const respond = (byUrl: (url: URL) => unknown) => {
    const seen: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url);
      seen.push(url);
      return new Response(JSON.stringify(byUrl(url)), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return seen;
  };
  const body = (queued: unknown) => ({ broadcast: { emailStats: { sent: 10, delivered: 9, bounced: 1, queued } } });

  it("reads the non-grouped broadcast emailStats.queued over the scope", async () => {
    const seen = respond(() => body(2505));
    expect(await fetchBroadcastQueuedEmails("brand-1", "camp-9", "sales-cold-email-outreach", HEADERS)).toBe(2505);
    expect(seen).toHaveLength(1);
    const q = seen[0].searchParams;
    expect(seen[0].pathname).toBe("/orgs/stats");
    expect(q.get("type")).toBe("broadcast");
    expect(q.get("groupBy")).toBeNull();
    expect(q.get("brandId")).toBe("brand-1");
    expect(q.get("featureSlugs")).toBe("sales-cold-email-outreach");
    expect(q.get("campaignId")).toBe("camp-9");
  });

  it("a measured empty queue is 0", async () => {
    respond(() => body(0));
    expect(await fetchBroadcastQueuedEmails("brand-1", undefined, "sales-cold-email-outreach", HEADERS)).toBe(0);
  });

  it("sums channels and a family in one campaignIds request per channel", async () => {
    const seen = respond((url) => body(url.searchParams.get("featureSlugs") === "a" ? 3 : 4));
    expect(await fetchBroadcastQueuedEmails("brand-1", ["c1", "c2"], ["a", "b"], HEADERS)).toBe(7);
    expect(seen).toHaveLength(2);
    expect(seen.every((u) => u.searchParams.get("campaignIds") === "c1,c2")).toBe(true);
  });

  it("one part the sender could not read nulls the sum (never counted as 0)", async () => {
    respond((url) => body(url.searchParams.get("featureSlugs") === "a" ? 3 : null));
    expect(await fetchBroadcastQueuedEmails("brand-1", undefined, ["a", "b"], HEADERS)).toBeNull();
  });

  it("throws when the gateway does not carry the count, or fails", async () => {
    respond(() => ({ broadcast: { emailStats: { sent: 1 } } }));
    await expect(fetchBroadcastQueuedEmails("brand-1", undefined, "a", HEADERS)).rejects.toThrow(/emailStats.queued/);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 404 }));
    await expect(fetchBroadcastQueuedEmails("brand-1", undefined, "a", HEADERS)).rejects.toThrow(/404/);
  });
});
