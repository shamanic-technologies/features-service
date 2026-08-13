import { describe, it, expect, vi, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchLeadsForRevenue } = await import("./leads-client.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

/** One lead-service /orgs/leads?view=basic row with the firmographic fields populated. */
function basicRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadId: "l1",
    email: "a@acme.com",
    contacted: true,
    clicked: true,
    replied: true,
    replyClassification: "positive",
    lead: {
      firstName: "Ada",
      lastName: "Lovelace",
      photoUrl: null,
      currentTitle: "VP of Engineering",
      seniority: "vp",
      organization: {
        id: "o1",
        name: "Acme",
        logoUrl: null,
        primaryDomain: "acme.com",
        websiteUrl: "https://acme.com",
        industry: "software",
        estimatedNumEmployees: 42,
        city: "Portland",
        country: "United States",
      },
    },
    ...over,
  };
}

function mockLeads(rows: Record<string, unknown>[]): string {
  let seenUrl = "";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
    return new Response(JSON.stringify({ leads: rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return seenUrl;
}

describe("fetchLeadsForRevenue — firmographic passthrough", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries person + company firmographics from view=basic onto the engine person", async () => {
    mockLeads([basicRow()]);

    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);

    expect(persons).toHaveLength(1);
    expect(persons[0]).toMatchObject({
      title: "VP of Engineering",
      seniority: "vp",
      orgIndustry: "software",
      orgEmployeeCount: 42,
      orgCity: "Portland",
      orgCountry: "United States",
    });
  });

  it("requests the slim view=basic projection", async () => {
    let seenUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      return new Response(JSON.stringify({ leads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(seenUrl).toContain("view=basic");
  });

  it("maps every unknown firmographic to null — no synthesis", async () => {
    mockLeads([
      basicRow({
        lead: {
          firstName: "Grace",
          lastName: "Hopper",
          photoUrl: null,
          // currentTitle + seniority absent
          organization: {
            id: "o2",
            name: "Beta",
            // industry / estimatedNumEmployees / city / country absent
          },
        },
      }),
    ]);

    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);

    expect(persons[0]).toMatchObject({
      title: null,
      seniority: null,
      orgIndustry: null,
      orgEmployeeCount: null,
      orgCity: null,
      orgCountry: null,
    });
  });

  it("maps null firmographics to null when the whole org is absent", async () => {
    mockLeads([
      basicRow({
        lead: {
          firstName: "No",
          lastName: "Org",
          photoUrl: null,
          currentTitle: "Analyst",
          seniority: "individual",
          organization: null,
        },
      }),
    ]);

    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);

    // Person firmographics survive even when the org is unknown.
    expect(persons[0]).toMatchObject({
      title: "Analyst",
      seniority: "individual",
      orgIndustry: null,
      orgEmployeeCount: null,
      orgCity: null,
      orgCountry: null,
    });
  });
});

describe("fetchLeadsForRevenue — one page, one parse", () => {
  afterEach(() => vi.restoreAllMocks());

  it("two simultaneous readers of the SAME page share ONE fetch, and each gets its own persons", async () => {
    // This process runs with a 384 MB heap and a big brand's lead page is the largest body it
    // parses; two simultaneous parses of one page do not fit. Identical inputs cannot have
    // different answers, so both callers are served from one read.
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ leads: [basicRow()] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const both = Promise.all([
      fetchLeadsForRevenue("brand-1", undefined, HEADERS),
      fetchLeadsForRevenue("brand-1", undefined, HEADERS),
    ]);
    release!();
    const [a, b] = await both;

    expect(calls).toBe(1);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    // Each caller maps its own persons — one mutating its signals must not move the other's.
    expect(a[0]).not.toBe(b[0]);
    a[0].signals.open = true;
    expect(b[0].signals.open).toBeUndefined();
  });

  it("a DIFFERENT scope is a different page — a campaign-scoped read is never served the brand's", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : (input as any).url);
      return new Response(JSON.stringify({ leads: [basicRow()] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await Promise.all([
      fetchLeadsForRevenue("brand-1", undefined, HEADERS),
      fetchLeadsForRevenue("brand-1", "camp-1", HEADERS),
      fetchLeadsForRevenue("brand-1", undefined, { ...HEADERS, orgId: "org-2" }),
    ]);

    expect(urls).toHaveLength(3);
  });

  it("is in-flight only — a later read goes back to lead-service, never to a stale page", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return new Response(JSON.stringify({ leads: [basicRow()] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(calls).toBe(2);
  });

  it("a failed page fails BOTH readers loudly, and the next read retries", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    });

    const results = await Promise.allSettled([
      fetchLeadsForRevenue("brand-1", undefined, HEADERS),
      fetchLeadsForRevenue("brand-1", undefined, HEADERS),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    const before = calls;
    await expect(fetchLeadsForRevenue("brand-1", undefined, HEADERS)).rejects.toThrow();
    expect(calls).toBeGreaterThan(before);
  });
});
