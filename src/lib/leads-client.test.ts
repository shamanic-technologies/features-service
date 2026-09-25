import { describe, it, expect, vi, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";

const { fetchLeadsForRevenue } = await import("./leads-client.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

/** One lead-service /orgs/leads?view=compact row with the firmographic fields populated. */
function compactRow(over: Record<string, unknown> = {}): Record<string, unknown> {
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

  it("carries person + company firmographics from view=compact onto the engine person", async () => {
    mockLeads([compactRow()]);

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

  it("requests the view=compact projection built for whole-population reads", async () => {
    let seenUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as any).url;
      return new Response(JSON.stringify({ leads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(new URL(seenUrl).searchParams.get("view")).toBe("compact");
  });

  it("every field it maps comes from the compact row — a row carrying EXACTLY the compact contract fills every person field", async () => {
    // The deployed compact contract (lead-service v0.81.7), key for key and nothing else. If the
    // mapping ever reads a field compact does not carry, that person field reads null here while
    // the fixture states a value for everything — so this fails instead of shipping blanks.
    const row = {
      id: "row-1",
      leadId: "l9",
      campaignId: "c9",
      workflowSlug: "wf-9",
      status: "contacted",
      email: "z@zeta.io",
      contacted: true,
      sent: true,
      delivered: true,
      opened: true,
      clicked: true,
      bounced: false,
      unsubscribed: false,
      replied: true,
      replyClassification: "negative",
      // lead-service#601: the positive reply the customer's CRM evidences.
      crmPositiveReplyAt: "2026-09-21T13:45:00.000Z",
      lead: {
        firstName: "Zed",
        lastName: "Zeta",
        photoUrl: "https://img/z.png",
        currentTitle: "CTO",
        seniority: "c_suite",
        organization: {
          id: "o9",
          name: "Zeta",
          logoUrl: "https://img/zeta.png",
          primaryDomain: "zeta.io",
          websiteUrl: "https://www.zeta.io",
          industry: "fintech",
          estimatedNumEmployees: 120,
          city: "Paris",
          country: "France",
        },
      },
    };
    mockLeads([row]);

    const [person] = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);

    expect(person).toEqual({
      leadId: "l9",
      campaignId: "c9",
      workflowSlug: "wf-9",
      email: "z@zeta.io",
      firstName: "Zed",
      lastName: "Zeta",
      photoUrl: "https://img/z.png",
      orgId: "o9",
      orgName: "Zeta",
      orgLogoUrl: "https://img/zeta.png",
      orgDomain: "zeta.io",
      title: "CTO",
      seniority: "c_suite",
      orgIndustry: "fintech",
      orgEmployeeCount: 120,
      orgCity: "Paris",
      orgCountry: "France",
      signals: {
        contacted: true,
        sent: true,
        delivered: true,
        bounced: false,
        unsubscribed: false,
        clicked: true,
        positiveReply: true,
        negativeReply: true,
        neutralReply: false,
      },
      signalDates: { positiveReply: "2026-09-21T13:45:00.000Z" },
      crmPositiveReplyAt: "2026-09-21T13:45:00.000Z",
    });
    for (const [key, value] of Object.entries(person)) {
      expect(value, `person.${key}`).not.toBeNull();
      expect(value, `person.${key}`).not.toBeUndefined();
    }
  });

  it("maps every unknown firmographic to null — no synthesis", async () => {
    mockLeads([
      compactRow({
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
      compactRow({
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
      return new Response(JSON.stringify({ leads: [compactRow()] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
      return new Response(JSON.stringify({ leads: [compactRow()] }), { status: 200, headers: { "Content-Type": "application/json" } });
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
      return new Response(JSON.stringify({ leads: [compactRow()] }), { status: 200, headers: { "Content-Type": "application/json" } });
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

describe("fetchLeadsForRevenue — a positive reply the customer's CRM evidences (lead-service#601)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is a positive reply, dated by the CRM, and marked CRM-ONLY when the sender classified none", async () => {
    mockLeads([compactRow({ replied: false, replyClassification: null, crmPositiveReplyAt: "2026-09-21T13:45:00.000Z" })]);
    const [person] = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(person.signals.positiveReply).toBe(true);
    expect(person.signalDates?.positiveReply).toBe("2026-09-21T13:45:00.000Z");
    expect(person.crmPositiveReplyAt).toBe("2026-09-21T13:45:00.000Z");
  });

  it("an email-classified positive reply witnessed by the CRM too is ONE reply and NOT CRM-only", async () => {
    mockLeads([compactRow({ replied: true, replyClassification: "positive", crmPositiveReplyAt: "2026-09-21T13:45:00.000Z" })]);
    const [person] = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(person.signals.positiveReply).toBe(true);
    expect(person.crmPositiveReplyAt).toBeNull();
  });

  it("no CRM reply and no classified one is no positive reply; a producer predating the field reads the same", async () => {
    mockLeads([compactRow({ replied: false, replyClassification: null, crmPositiveReplyAt: null }), compactRow({ leadId: "l2", replied: false, replyClassification: null })]);
    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    for (const p of persons) {
      expect(p.signals.positiveReply).toBe(false);
      expect(p.crmPositiveReplyAt).toBeNull();
    }
  });

  it("a bounced / unsubscribed lead converts nothing, the CRM reply included (same rule as the email one)", async () => {
    mockLeads([compactRow({ unsubscribed: true, crmPositiveReplyAt: "2026-09-21T13:45:00.000Z" })]);
    const [person] = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(person.signals.positiveReply).toBe(false);
    expect(person.crmPositiveReplyAt).toBeNull();
  });
});
