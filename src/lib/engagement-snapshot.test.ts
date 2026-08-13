import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two upstream fetchers; dedupPersonsByLead (revenue-engine) stays REAL — it's the
// shared primitive that guarantees the snapshot count matches /revenue's deduped lead set.
const mockFetchLeads = vi.fn();
const mockFetchTs = vi.fn();
vi.mock("./leads-client.js", () => ({ fetchLeadsForRevenue: (...a: unknown[]) => mockFetchLeads(...a) }));
vi.mock("./email-status-client.js", () => ({ fetchEventTimestamps: (...a: unknown[]) => mockFetchTs(...a) }));

import { fetchEngagementSnapshotCounts, fetchEngagementSnapshotByIdentity } from "./engagement-snapshot.js";
import { computeRevenue, buildSignalSeries, type ResolvedPath, type EnginePerson } from "./revenue-engine.js";

const H = { orgId: "o1" };

function person(over: Partial<EnginePerson> & { leadId: string; signals: Record<string, boolean> }): EnginePerson {
  return {
    firstName: "A",
    lastName: "B",
    photoUrl: null,
    orgId: null,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    email: null,
    ...over,
  };
}

const sig = (over: Record<string, boolean> = {}): Record<string, boolean> => ({
  contacted: false,
  sent: false,
  delivered: false,
  clicked: false,
  positiveReply: false,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mockFetchTs.mockResolvedValue(new Map());
});

describe("fetchEngagementSnapshotCounts — dedup + bounce (the #388 +1 drift)", () => {
  it("counts a lead clicked across two campaign rows ONCE (dedupPersonsByLead OR), excludes a bounced-zeroed lead", async () => {
    // L1 appears twice (the Sibylle Linnebo case): clicked in one row, not the other → dedup ORs to clicked.
    // L2 is bounced/unsubscribed → leads-client already zeroed all its signals.
    mockFetchLeads.mockResolvedValue([
      person({ leadId: "L1", email: "a@x.com", signals: sig({ contacted: true, sent: true, delivered: true, clicked: true }) }),
      person({ leadId: "L1", email: "a@x.com", signals: sig({ contacted: true, sent: true, delivered: true, clicked: false }) }),
      person({ leadId: "L2", email: "b@x.com", signals: sig() }),
      person({ leadId: "L3", email: "c@x.com", signals: sig({ contacted: true, sent: true, delivered: true, clicked: true, positiveReply: true }) }),
    ]);

    const counts = await fetchEngagementSnapshotCounts("brand1", undefined, H);

    // Email-gateway aggregate would count the L1 duplicate twice → recipientsClicked = 3. Deduped = 2.
    expect(counts.recipientsClicked).toBe(2);
    expect(counts.recipientsContacted).toBe(2); // L1, L3 (L2 zeroed)
    expect(counts.recipientsSent).toBe(2);
    expect(counts.recipientsDelivered).toBe(2);
    expect(counts.recipientsRepliesPositive).toBe(1); // L3
    expect(counts.recipientsOpened).toBe(0); // no open timestamps
  });
});

describe("fetchEngagementSnapshotByIdentity — an identity's people are counted the way its brand's are", () => {
  /** Two members of ONE identity, plus an unrelated campaign on its own. */
  const IDENTITY_OF = (cid: string): string => (cid === "stopped" || cid === "live" ? "family" : `campaign:${cid}`);

  it("counts a person served under SEVERAL members of one identity ONCE — the case that produced the over-count", async () => {
    mockFetchLeads.mockResolvedValue([
      // The same lead, re-served under the live campaign after its ancestor stopped. Adding the two
      // members' per-campaign rows would report 2 people contacted; there is only one person.
      person({ leadId: "shared", email: "a@x.com", campaignId: "stopped", signals: sig({ contacted: true, sent: true, delivered: true }) }),
      person({ leadId: "shared", email: "a@x.com", campaignId: "live", signals: sig({ contacted: true, sent: true, delivered: true, clicked: true }) }),
      person({ leadId: "only-live", email: "b@x.com", campaignId: "live", signals: sig({ contacted: true, sent: true, delivered: true, positiveReply: true }) }),
    ]);

    const byIdentity = await fetchEngagementSnapshotByIdentity("brand1", IDENTITY_OF, H);

    expect(byIdentity.get("family")).toMatchObject({
      recipientsContacted: 2, // shared + only-live, NOT 3
      recipientsSent: 2,
      recipientsDelivered: 2,
      recipientsClicked: 1, // the shared lead's click, counted once
      recipientsRepliesPositive: 1,
    });
  });

  it("never reports more people than the brand — every signal, for every identity", async () => {
    mockFetchLeads.mockResolvedValue([
      person({ leadId: "shared", email: "a@x.com", campaignId: "stopped", signals: sig({ contacted: true, sent: true, delivered: true, clicked: true }) }),
      person({ leadId: "shared", email: "a@x.com", campaignId: "live", signals: sig({ contacted: true, sent: true, delivered: true, positiveReply: true }) }),
      person({ leadId: "other", email: "b@x.com", campaignId: "unrelated", signals: sig({ contacted: true, sent: true, delivered: true, bounced: true }) }),
    ]);
    mockFetchTs.mockResolvedValue(new Map([["a@x.com", { open: "2026-06-20T00:00:00Z" }]]));

    const brand = await fetchEngagementSnapshotCounts("brand1", undefined, H);
    const byIdentity = await fetchEngagementSnapshotByIdentity("brand1", IDENTITY_OF, H);

    expect(byIdentity.size).toBe(2);
    for (const counts of byIdentity.values()) {
      for (const [key, value] of Object.entries(counts)) {
        expect(value).toBeLessThanOrEqual(brand[key as keyof typeof brand]);
      }
    }
  });

  it("splits the brand's leads by identity — an identity reports only the people its own campaigns reached", async () => {
    mockFetchLeads.mockResolvedValue([
      person({ leadId: "l1", email: "a@x.com", campaignId: "stopped", signals: sig({ contacted: true }) }),
      person({ leadId: "l2", email: "b@x.com", campaignId: "unrelated", signals: sig({ contacted: true }) }),
      // A row whose producer states no campaign belongs to no identity — counted for neither.
      person({ leadId: "l3", email: "c@x.com", campaignId: null, signals: sig({ contacted: true }) }),
    ]);

    const byIdentity = await fetchEngagementSnapshotByIdentity("brand1", IDENTITY_OF, H);

    expect(byIdentity.get("family")?.recipientsContacted).toBe(1);
    expect(byIdentity.get("campaign:unrelated")?.recipientsContacted).toBe(1);
    expect([...byIdentity.keys()].sort()).toEqual(["campaign:unrelated", "family"]);
  });

  it("reads the brand ONCE — never one lead fetch per identity", async () => {
    mockFetchLeads.mockResolvedValue([
      person({ leadId: "l1", email: "a@x.com", campaignId: "stopped", signals: sig({ contacted: true }) }),
      person({ leadId: "l2", email: "b@x.com", campaignId: "unrelated", signals: sig({ contacted: true }) }),
    ]);

    await fetchEngagementSnapshotByIdentity("brand1", IDENTITY_OF, H);

    expect(mockFetchLeads).toHaveBeenCalledTimes(1);
    expect(mockFetchLeads).toHaveBeenCalledWith("brand1", undefined, H);
    expect(mockFetchTs).toHaveBeenCalledTimes(1);
  });

  it("lead fetch stays fail-loud (no silently under-reported identity)", async () => {
    mockFetchLeads.mockRejectedValue(new Error("lead-service 502"));
    await expect(fetchEngagementSnapshotByIdentity("brand1", IDENTITY_OF, H)).rejects.toThrow("lead-service 502");
  });
});

describe("fetchEngagementSnapshotCounts — opened from timestamp overlay only", () => {
  it("counts opened ONLY for leads with an email-gateway open timestamp (no lead-row open boolean)", async () => {
    mockFetchLeads.mockResolvedValue([
      person({ leadId: "L1", email: "a@x.com", signals: sig({ contacted: true, delivered: true }) }),
      person({ leadId: "L2", email: "b@x.com", signals: sig({ contacted: true, delivered: true }) }),
    ]);
    mockFetchTs.mockResolvedValue(new Map([["a@x.com", { open: "2026-06-20T00:00:00Z" }]]));

    const counts = await fetchEngagementSnapshotCounts("brand1", undefined, H);
    expect(counts.recipientsOpened).toBe(1); // only L1 has an open ts
  });
});

describe("fetchEngagementSnapshotCounts — failure modes mirror /revenue", () => {
  it("open-overlay is best-effort: an email-gateway failure degrades opened to 0, other counts intact, no throw", async () => {
    mockFetchLeads.mockResolvedValue([
      person({ leadId: "L1", email: "a@x.com", signals: sig({ contacted: true, delivered: true, clicked: true }) }),
    ]);
    mockFetchTs.mockRejectedValue(new Error("email-gateway down"));

    const counts = await fetchEngagementSnapshotCounts("brand1", undefined, H);
    expect(counts.recipientsOpened).toBe(0);
    expect(counts.recipientsClicked).toBe(1);
    expect(counts.recipientsContacted).toBe(1);
  });

  it("lead fetch is fail-loud: a lead-service error propagates (no silent under-report)", async () => {
    mockFetchLeads.mockRejectedValue(new Error("lead-service 502"));
    await expect(fetchEngagementSnapshotCounts("brand1", undefined, H)).rejects.toThrow("lead-service 502");
  });
});

describe("fetchEngagementSnapshotCounts — INVARIANT: equals /revenue's deduped lead counts", () => {
  // The exact paths /revenue resolves (delivery stages + engagement) so every engaged lead has
  // evRaw>0 and survives into result.leads — same population the snapshot counts.
  const STAGE_PATHS: ResolvedPath[] = [
    { tag: "contacted", signal: "contacted", expectedRevenueUsd: 3, kind: "delivery" },
    { tag: "sent", signal: "sent", expectedRevenueUsd: 6, kind: "delivery" },
    { tag: "delivered", signal: "delivered", expectedRevenueUsd: 12, kind: "delivery" },
    { tag: "visit", signal: "clicked", expectedRevenueUsd: 20, kind: "engagement" },
    { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 120, kind: "engagement" },
  ];

  it("recipientsContacted/Opened/Clicked === clicked.total/opened.total/contacted.total from computeRevenue", async () => {
    // /revenue path: persons with `open` already set pre-engine (Wave B overlay), fed to computeRevenue.
    const withOpen = (over: Record<string, boolean>): Record<string, boolean> => sig({ contacted: true, sent: true, delivered: true, ...over });
    const revenuePersons: EnginePerson[] = [
      person({ leadId: "l1", email: "a@x.com", signals: withOpen({ clicked: true, open: true }) }),
      person({ leadId: "l2", email: "b@x.com", signals: withOpen({ clicked: false, open: true }) }),
      person({ leadId: "l3", email: "c@x.com", signals: withOpen({ clicked: false, open: false }) }),
    ];
    const r = computeRevenue(STAGE_PATHS, revenuePersons.map((p) => ({ ...p, signals: { ...p.signals } })));
    const revClicked = buildSignalSeries(r.leads, (l) => l.clicked, (l) => l.clickedAt).total;
    const revOpened = buildSignalSeries(r.leads, (l) => l.opened, (l) => l.openedAt).total;
    const revContacted = buildSignalSeries(r.leads, (l) => l.contacted, (l) => l.contactedAt).total;

    // /stats snapshot path: SAME persons but `open` derived from timestamps (no lead-row boolean).
    mockFetchLeads.mockResolvedValue(
      revenuePersons.map((p) => {
        const s = { ...p.signals };
        delete s.open;
        return { ...p, signals: s };
      }),
    );
    mockFetchTs.mockResolvedValue(new Map([["a@x.com", { open: "2026-06-20T00:00:00Z" }], ["b@x.com", { open: "2026-06-20T00:00:00Z" }]]));

    const counts = await fetchEngagementSnapshotCounts("brand1", undefined, H);

    expect(counts.recipientsClicked).toBe(revClicked); // 1
    expect(counts.recipientsOpened).toBe(revOpened); // 2
    expect(counts.recipientsContacted).toBe(revContacted); // 3
  });
});
