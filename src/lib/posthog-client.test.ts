import { describe, it, expect, vi, afterEach } from "vitest";

process.env.POSTHOG_API_HOST = "https://eu.posthog.com";
process.env.POSTHOG_PROJECT_ID = "171095";
process.env.POSTHOG_PERSONAL_API_KEY = "phx_test_key";

const { fetchDashboardReturnsByOrg } = await import("./posthog-client.js");

const NOW = new Date("2026-07-15T12:00:00.000Z");

describe("fetchDashboardReturnsByOrg", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps the HogQL matrix per Clerk org id; derives daysSinceLastSeen from now; Bearer auth to the project /query/ endpoint", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      seenBody = (init?.body as string) ?? "";
      return new Response(
        JSON.stringify({
          results: [
            ["org_abc", 9, 40, 55, 220, "2026-07-13T10:00:00.000000Z"],
            ["org_def", 0, 3, 0, 12, "2026-06-20T08:00:00.000000Z"],
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const map = await fetchDashboardReturnsByOrg(NOW);

    expect(seenUrl).toBe("https://eu.posthog.com/api/projects/171095/query/");
    expect(seenHeaders["Authorization"]).toBe("Bearer phx_test_key");
    expect(seenBody).toContain("HogQLQuery");
    expect(seenBody).toContain("$pageview");

    expect(map.get("org_abc")).toEqual({
      sessions7d: 9,
      sessions30d: 40,
      pageviews7d: 55,
      pageviews30d: 220,
      lastSeen: "2026-07-13T10:00:00.000Z",
      daysSinceLastSeen: 2,
    });
    expect(map.get("org_def")?.daysSinceLastSeen).toBe(25);
  });

  it("skips rows with an empty org id (never fabricates a key)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ results: [["", 1, 1, 1, 1, "2026-07-14T00:00:00Z"], ["org_x", 2, 2, 2, 2, null]] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const map = await fetchDashboardReturnsByOrg(NOW);
    expect(map.has("")).toBe(false);
    expect(map.get("org_x")).toEqual({ sessions7d: 2, sessions30d: 2, pageviews7d: 2, pageviews30d: 2, lastSeen: null, daysSinceLastSeen: null });
  });

  it("fails loud on a non-OK response (soft-degrade happens in the board, not here)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(fetchDashboardReturnsByOrg(NOW)).rejects.toThrow(/posthog \/query\/ failed \(403\)/);
  });

  it("fails loud when the results matrix is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    await expect(fetchDashboardReturnsByOrg(NOW)).rejects.toThrow(/no results matrix/);
  });

  it("fails loud when POSTHOG_* config is missing", async () => {
    const saved = process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    await expect(fetchDashboardReturnsByOrg(NOW)).rejects.toThrow(/not configured/);
    process.env.POSTHOG_PERSONAL_API_KEY = saved;
  });
});
