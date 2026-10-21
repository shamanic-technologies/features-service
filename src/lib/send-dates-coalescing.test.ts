/**
 * One send-date read per scope at a time (2026-10-21): three simultaneous brand-wide asks made instantly-service
 * time out behind email-gateway (502 at ~21 s). Concurrent asks of one scope are serialised and share one answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.EMAIL_GATEWAY_SERVICE_URL = "http://gw:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "gw-key";
const { fetchEventTimestamps, __resetSendDatesMemory } = await import("./email-status-client.js");

const H = { orgId: "org-1" };
const emails = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `p${i + from}@acme.com`);

let inFlight = 0;
let maxInFlight = 0;
let asked: number[] = [];
function mockGateway(opts: { failFirst?: boolean } = {}) {
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const items = (JSON.parse(String(init?.body)) as { items: Array<{ email: string }> }).items;
    asked.push(items.length);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    if (opts.failFirst && calls === 1) return new Response("Upstream service error", { status: 502 });
    return Response.json({
      results: items.map(({ email }) => ({ email, broadcast: { brand: { firstSentAt: "2026-10-01T00:00:00Z", lastDeliveredAt: "2026-10-02T00:00:00Z" } } })),
    });
  });
}

describe("send dates: asks of one scope are serialised and share one answer", () => {
  beforeEach(() => {
    process.env.SEND_DATES_MEMORY_MS = "60000";
    __resetSendDatesMemory();
    inFlight = 0;
    maxInFlight = 0;
    asked = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.SEND_DATES_MEMORY_MS = "0";
  });

  it("three simultaneous brand-wide reads (the board + revenue read) make ONE call at a time, and ask each address once", async () => {
    mockGateway();
    const all = emails(100);
    const [a, b, c] = await Promise.all([
      fetchEventTimestamps("b1", undefined, all.slice(0, 90), H),
      fetchEventTimestamps("b1", undefined, all, H),
      fetchEventTimestamps("b1", undefined, all, H),
    ]);
    expect(maxInFlight).toBe(1);
    // ONE ask of their union: instantly-service sees one address list, one aggregation.
    expect(asked).toEqual([100]);
    expect(a.size).toBe(90);
    expect(b.size).toBe(100);
    expect(c.get("p99@acme.com")?.lastSent).toBe("2026-10-02T00:00:00Z");
  });

  it("another brand or campaign is its own scope (never answered from someone else's)", async () => {
    mockGateway();
    await Promise.all([
      fetchEventTimestamps("b1", undefined, emails(5), H),
      fetchEventTimestamps("b2", undefined, emails(5), H),
      fetchEventTimestamps("b1", "camp-1", emails(5), H),
    ]);
    expect(asked).toEqual([5, 5, 5]);
  });

  it("a failed ask remembers nothing: its callers get the error, the next ask asks again", async () => {
    mockGateway({ failFirst: true });
    const [first, second] = await Promise.allSettled([
      fetchEventTimestamps("b1", undefined, emails(10), H),
      fetchEventTimestamps("b1", undefined, emails(10), H),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("rejected");
    const again = await fetchEventTimestamps("b1", undefined, emails(10), H);
    expect(again.size).toBe(10);
    expect(asked).toEqual([10, 10]);
  });

  it("a later ask inside the window is answered from what is known, asking only new addresses", async () => {
    mockGateway();
    await fetchEventTimestamps("b1", undefined, emails(10), H);
    const later = await fetchEventTimestamps("b1", undefined, emails(12), H);
    const again = await fetchEventTimestamps("b1", undefined, emails(5), H);
    expect(later.size).toBe(12);
    expect(again.size).toBe(5);
    expect(asked).toEqual([10, 2]);
  });

  it("without a memory window every read asks (the suite default)", async () => {
    process.env.SEND_DATES_MEMORY_MS = "0";
    mockGateway();
    await fetchEventTimestamps("b1", undefined, emails(3), H);
    await fetchEventTimestamps("b1", undefined, emails(3), H);
    expect(asked).toEqual([3, 3]);
  });
});
