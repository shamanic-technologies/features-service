import { describe, it, expect, vi, afterEach } from "vitest";

process.env.KEY_SERVICE_URL = "http://key:3003";
process.env.KEY_SERVICE_API_KEY = "key-svc-key";

const { fetchDashboardReturnsByOrg } = await import("./posthog-client.js");

const NOW = new Date("2026-07-15T12:00:00.000Z");

/** Mock both hops: key-service platform decrypt → the personal key, then the PostHog /query/ matrix. */
function mockKeyThenQuery(matrix: unknown[][] | { status: number; body?: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    if (url.includes("/keys/platform/posthog/decrypt")) {
      return new Response(JSON.stringify({ provider: "posthog", key: "phx_from_keyservice" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // PostHog /query/
    if (!Array.isArray(matrix)) return new Response(matrix.body ?? "err", { status: matrix.status });
    return new Response(JSON.stringify({ results: matrix }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("fetchDashboardReturnsByOrg", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the key from key-service, then maps the HogQL matrix per Clerk org id; Bearer auth to the project /query/", async () => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body as string });
      if (url.includes("/keys/platform/posthog/decrypt")) {
        return new Response(JSON.stringify({ provider: "posthog", key: "phx_from_keyservice" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ results: [["org_abc", 9, 40, 55, 220, "2026-07-13T10:00:00.000000Z"], ["org_def", 0, 3, 0, 12, "2026-06-20T08:00:00.000000Z"]] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const map = await fetchDashboardReturnsByOrg(NOW);

    const keyCall = calls.find((c) => c.url.includes("/keys/platform/posthog/decrypt"))!;
    expect(keyCall.url).toBe("http://key:3003/keys/platform/posthog/decrypt");
    expect(keyCall.headers["x-api-key"]).toBe("key-svc-key");
    expect(keyCall.headers["x-caller-service"]).toBe("features-service");

    const queryCall = calls.find((c) => c.url.includes("/query/"))!;
    expect(queryCall.url).toBe("https://eu.posthog.com/api/projects/171095/query/");
    expect(queryCall.headers["Authorization"]).toBe("Bearer phx_from_keyservice");
    expect(queryCall.body).toContain("$pageview");

    expect(map.get("org_abc")).toEqual({ sessions7d: 9, sessions30d: 40, pageviews7d: 55, pageviews30d: 220, lastSeen: "2026-07-13T10:00:00.000Z", daysSinceLastSeen: 2 });
    expect(map.get("org_def")?.daysSinceLastSeen).toBe(25);
  });

  it("skips rows with an empty org id (never fabricates a key)", async () => {
    mockKeyThenQuery([["", 1, 1, 1, 1, "2026-07-14T00:00:00Z"], ["org_x", 2, 2, 2, 2, null]]);
    const map = await fetchDashboardReturnsByOrg(NOW);
    expect(map.has("")).toBe(false);
    expect(map.get("org_x")).toEqual({ sessions7d: 2, sessions30d: 2, pageviews7d: 2, pageviews30d: 2, lastSeen: null, daysSinceLastSeen: null });
  });

  it("fails loud on a non-OK PostHog response (soft-degrade happens in the board, not here)", async () => {
    mockKeyThenQuery({ status: 403, body: "nope" });
    await expect(fetchDashboardReturnsByOrg(NOW)).rejects.toThrow(/posthog \/query\/ failed \(403\)/);
  });

  it("fails loud when key-service has no posthog provider (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider not registered", { status: 404 }));
    await expect(fetchDashboardReturnsByOrg(NOW)).rejects.toThrow(/key-service GET \/keys\/platform\/posthog\/decrypt failed \(404\)/);
  });

  it("fails loud when KEY_SERVICE config is missing", async () => {
    const saved = process.env.KEY_SERVICE_API_KEY;
    delete process.env.KEY_SERVICE_API_KEY;
    await expect(fetchDashboardReturnsByOrg(NOW)).rejects.toThrow(/KEY_SERVICE_URL or KEY_SERVICE_API_KEY not configured/);
    process.env.KEY_SERVICE_API_KEY = saved;
  });
});
