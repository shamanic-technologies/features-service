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
          .filter((i) => i.email !== "unknown@x")
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
    const emails = ["a@x", "b@x", "unknown@x"];
    registerEmailFingerprints(SCOPE, [row("1", "a@x"), row("2", "b@x"), row("3", "unknown@x")]);
    const first = await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, emails, H));

    registerEmailFingerprints(SCOPE, [row("1", "a@x", { opened: true }), row("2", "b@x"), row("3", "unknown@x")]);
    const second = await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, emails, H));

    expect(asked).toEqual([emails, ["a@x"]]);
    // Same map a full ask returns — an email the producer does not know stays absent.
    expect([...second.keys()].sort()).toEqual(["a@x", "b@x"]);
    expect(second.get("b@x")).toEqual(first.get("b@x"));
  });

  it("asks every email, every time, outside a live-copy read", async () => {
    registerEmailFingerprints(SCOPE, [row("1", "a@x")]);
    await fetchEventTimestamps("brand-1", undefined, ["a@x"], H);
    await fetchEventTimestamps("brand-1", undefined, ["a@x"], H);
    expect(asked).toEqual([["a@x"], ["a@x"]]);
  });

  it("asks an email the copy has no fingerprint for", async () => {
    registerEmailFingerprints(SCOPE, [row("1", "a@x")]);
    await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, ["a@x", "new@x"], H));
    await withLiveLeadCopy(() => fetchEventTimestamps("brand-1", undefined, ["a@x", "new@x"], H));
    expect(asked).toEqual([["a@x", "new@x"], ["new@x"]]);
  });
});
