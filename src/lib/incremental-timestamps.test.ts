/**
 * Inside a live-copy read, `/orgs/status` is asked only for the emails whose delivery flags changed
 * since they were last asked — and the answer is the same map a full ask returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.EMAIL_GATEWAY_SERVICE_URL = "http://email:3000";
process.env.EMAIL_GATEWAY_SERVICE_API_KEY = "k";

const { fetchEventTimestamps, __resetTimestampCaches } = await import("./email-status-client.js");
const { withLiveLeadCopy, registerEmailFingerprints, fingerprintScopeKey, __resetLeadCopies } = await import("./lead-copy.js");

const H = { orgId: "org-1" };
const SCOPE = fingerprintScopeKey("org-1", "brand-1", undefined);
const row = (id: string, email: string, extra: Record<string, unknown> = {}) => ({ id, leadId: id, email, opened: false, clicked: false, ...extra });

let asked: string[][] = [];
function mockStatus(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { items: Array<{ email: string }> };
    asked.push(body.items.map((i) => i.email));
    return new Response(
      JSON.stringify({
        results: body.items
          .filter((i) => i.email !== "unknown@x.io")
          .map((i) => ({ email: i.email, broadcast: { brand: { firstOpenedAt: `open-${i.email}` } } })),
      }),
      { status: 200 },
    );
  });
}

describe("incremental event timestamps", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.LEAD_COPY_ENABLED;
    delete process.env.LEAD_COPY_ENABLED;
    __resetLeadCopies();
    __resetTimestampCaches();
    asked = [];
    mockStatus();
  });
  afterEach(() => {
    process.env.LEAD_COPY_ENABLED = saved;
    vi.restoreAllMocks();
  });

  it("asks everything once, then only the emails whose flags changed", async () => {
    const emails = ["a@x.io", "b@x.io", "unknown@x.io"];
    registerEmailFingerprints(SCOPE, [row("1", "a@x.io"), row("2", "b@x.io"), row("3", "unknown@x.io")]);
    const first = await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, emails, H));

    registerEmailFingerprints(SCOPE, [row("1", "a@x.io", { opened: true }), row("2", "b@x.io"), row("3", "unknown@x.io")]);
    const second = await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, emails, H));

    expect(asked).toEqual([emails, ["a@x.io"]]);
    // Same map a full ask returns — an email the producer does not know stays absent.
    expect([...second.keys()].sort()).toEqual(["a@x.io", "b@x.io"]);
    expect(second.get("b@x.io")).toEqual(first.get("b@x.io"));
  });

  it("asks every email, every time, outside a live-copy read", async () => {
    registerEmailFingerprints(SCOPE, [row("1", "a@x.io")]);
    await fetchEventTimestamps("brand-1", undefined, ["a@x.io"], H);
    await fetchEventTimestamps("brand-1", undefined, ["a@x.io"], H);
    expect(asked).toEqual([["a@x.io"], ["a@x.io"]]);
  });

  it("asks an email the copy has no fingerprint for", async () => {
    registerEmailFingerprints(SCOPE, [row("1", "a@x.io")]);
    await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, ["a@x.io", "new@x.io"], H));
    await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, ["a@x.io", "new@x.io"], H));
    expect(asked).toEqual([["a@x.io", "new@x.io"], ["new@x.io"]]);
  });
  it("leaves out an address email-gateway refuses (one would fail the whole batch) and still answers the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unsub = "x====@unsubscribe2.customer.io";
    const got = await fetchEventTimestamps("brand-1", undefined, ["a@x.io", unsub], H);
    expect(asked).toEqual([["a@x.io"]]);
    expect([...got.keys()]).toEqual(["a@x.io"]);
  });
});
