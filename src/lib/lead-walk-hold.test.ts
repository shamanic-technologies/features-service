import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.LEAD_PAGE_SIZE = "2";

const { fetchLeadsForRevenue } = await import("./leads-client.js");
const { __leadWalkCounters, __leadWalkDecodeCounters, __resetLeadWalkHold, dropHeldLeadWalksForOrgs, heldLeadWalk } = await import("./lead-walk-hold.js");
const { withLiveLeadCopy } = await import("./lead-copy.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

function row(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `lc-${i}`,
    leadId: `l${i}`,
    campaignId: `c${i % 2}`,
    workflowSlug: "wf-a",
    lastServedAt: i === 3 ? null : `2026-10-0${i}T10:00:00.000Z`,
    audienceId: i === 2 ? null : "aud-1",
    email: `p${i}@acme${i}.com`,
    contacted: true,
    sent: i !== 4,
    delivered: i !== 4,
    clicked: i % 2 === 0,
    bounced: i === 4,
    unsubscribed: false,
    replied: i === 1 || i === 5,
    replyClassification: i === 1 ? "positive" : i === 5 ? "negative" : null,
    crmPositiveReplyAt: i === 2 ? "2026-10-05T00:00:00.000Z" : null,
    lead: {
      firstName: `F${i}`,
      lastName: null,
      photoUrl: null,
      currentTitle: "VP",
      seniority: "vp",
      country: i === 3 ? null : "FR",
      organization: { id: `o${i}`, name: `Acme ${i}`, logoUrl: null, primaryDomain: null, websiteUrl: `https://www.acme${i}.com/x`, industry: null, estimatedNumEmployees: 10, city: null, country: "FR" },
    },
    ...over,
  };
}

/** Five rows served in pages of two (three pages), keyed by the cursor; counts every page request per org. */
function serveLeads(rows: Record<string, unknown>[], opts: { failFirst?: boolean } = {}): { pages: () => number } {
  let pages = 0;
  let failed = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    if (url.pathname.startsWith("/internal/users")) return new Response(JSON.stringify({ users: [] }), { status: 200 });
    if (url.pathname !== "/orgs/leads") throw new Error(`unexpected ${url}`);
    if (opts.failFirst && !failed) {
      failed = true;
      return new Response("boom", { status: 400 });
    }
    pages += 1;
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const size = Number(url.searchParams.get("limit"));
    const slice = rows.slice(start, start + size);
    const next = start + size < rows.length ? String(start + size) : null;
    return new Response(JSON.stringify({ leads: slice, nextCursor: next }), { status: 200 });
  });
  return { pages: () => pages };
}

const ROWS = [1, 2, 3, 4, 5].map((i) => row(i));

/**
 * The brand-wide reads ONE 15-min fleet cycle makes of one (org, brand) pair in one process, per the
 * caller inventory (BOX-DB-LOAD-1027-FEATURES-LEADS): cross-org revenue 1, return snapshots 3 (one per
 * channel + one per declared funnel, a 1-channel 2-funnel brand), workflow return pipelines 1, customer
 * health 4 (brand revenue, audience stats ×2, projection persons), fleet person cell 1, internal pipe
 * fleet 1, outcome prices 1 (bypasses the internal fleet's cache).
 */
const READS_PER_PAIR_PER_CYCLE = 12;

describe("held fleet lead walk (lib/lead-walk-hold.ts)", () => {
  let savedHold: string | undefined;
  beforeEach(() => {
    savedHold = process.env.LEAD_WALK_HOLD_MS;
    __resetLeadWalkHold();
  });
  afterEach(() => {
    process.env.LEAD_WALK_HOLD_MS = savedHold;
    vi.restoreAllMocks();
    __resetLeadWalkHold();
  });

  it("serves a held read the SAME persons a fresh walk returns on the same data", async () => {
    process.env.LEAD_WALK_HOLD_MS = "0";
    const fresh = serveLeads(ROWS);
    const walked = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(fresh.pages()).toBe(3);
    vi.restoreAllMocks();

    process.env.LEAD_WALK_HOLD_MS = "600000";
    const held = serveLeads(ROWS);
    const first = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    const second = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    const family = await fetchLeadsForRevenue("brand-1", ["c0", "c1"], HEADERS);
    expect(held.pages()).toBe(3);
    expect(first).toEqual(walked);
    expect(second).toEqual(walked);
    // A family list reads the brand-wide page, so it shares the held walk and filters it the same way.
    expect(family).toEqual(walked);
    // Absent vs null survives the round trip (servedAt / audienceId / leadCountry distinguish them).
    expect(second.find((p) => p.leadId === "l3")).toMatchObject({ servedAt: null, leadCountry: null });
    expect(second.find((p) => p.leadId === "l2")).toMatchObject({ audienceId: null });
  });

  it("one fleet cycle reads each pair's pages once instead of once per caller (>= 5x fewer)", async () => {
    const pairs = [
      { orgId: "org-1", brandId: "brand-1" },
      { orgId: "org-2", brandId: "brand-2" },
      { orgId: "org-1", brandId: "brand-3" },
    ];
    const cycle = async () => {
      for (let n = 0; n < READS_PER_PAIR_PER_CYCLE; n++) {
        for (const p of pairs) await fetchLeadsForRevenue(p.brandId, undefined, { orgId: p.orgId });
      }
    };

    process.env.LEAD_WALK_HOLD_MS = "0";
    const before = serveLeads(ROWS);
    await cycle();
    const pagesBefore = before.pages();
    vi.restoreAllMocks();
    __resetLeadWalkHold();

    process.env.LEAD_WALK_HOLD_MS = "600000";
    const after = serveLeads(ROWS);
    await cycle();
    const pagesAfter = after.pages();

    expect(pagesBefore).toBe(READS_PER_PAIR_PER_CYCLE * pairs.length * 3);
    expect(pagesAfter).toBe(pairs.length * 3);
    expect(pagesBefore / pagesAfter).toBeGreaterThanOrEqual(5);
    const c = __leadWalkCounters();
    expect(c.pagesRead).toBe(pagesAfter);
    expect(c.pagesRead + c.pagesSpared).toBe(pagesBefore);
  });

  it("concurrent reads of one scope share ONE walk", async () => {
    process.env.LEAD_WALK_HOLD_MS = "600000";
    const s = serveLeads(ROWS);
    const all = await Promise.all([1, 2, 3, 4].map(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS)));
    expect(s.pages()).toBe(3);
    for (const r of all) expect(r).toEqual(all[0]);
  });

  it("never serves a walk past its window: the next read walks again", async () => {
    process.env.LEAD_WALK_HOLD_MS = "40";
    const s = serveLeads(ROWS);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    await new Promise((r) => setTimeout(r, 60));
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(s.pages()).toBe(6);
  });

  it("is keyed on the org and the exact request: another org, or one campaign, walks its own", async () => {
    process.env.LEAD_WALK_HOLD_MS = "600000";
    const s = serveLeads(ROWS);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    await fetchLeadsForRevenue("brand-1", undefined, { orgId: "org-2" });
    await fetchLeadsForRevenue("brand-1", "c0", HEADERS);
    expect(s.pages()).toBe(9);
  });

  it("never holds a failed walk (fail loud), and serves an interactive read only a walk of the same 30 s instant", async () => {
    process.env.LEAD_WALK_HOLD_MS = "600000";
    const s = serveLeads(ROWS, { failFirst: true });
    await expect(fetchLeadsForRevenue("brand-1", undefined, HEADERS)).rejects.toThrow(/400/);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(s.pages()).toBe(3);
    // Inside a view compute (live copy switched off by the suite env): a walk taken this instant is reused...
    await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS));
    expect(s.pages()).toBe(3);
    // ...an older one never is: the read walks fresh.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS));
      expect(s.pages()).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a brand transfer drops the orgs' held walks", async () => {
    process.env.LEAD_WALK_HOLD_MS = "600000";
    const s = serveLeads(ROWS);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(dropHeldLeadWalksForOrgs(["org-1"])).toBe(1);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(s.pages()).toBe(6);
    expect(__leadWalkCounters().heldScopes).toBe(1);
  });
  it("held reads share ONE decode (BOX-CPU-1028): concurrent reads and the reads right after the walk decode nothing again", async () => {
    process.env.LEAD_WALK_HOLD_MS = "0";
    serveLeads(ROWS);
    const walked = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    vi.restoreAllMocks();

    process.env.LEAD_WALK_HOLD_MS = "600000";
    serveLeads(ROWS);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    const reads = await Promise.all([1, 2, 3, 4, 5].map(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS)));
    for (const r of reads) expect(r).toEqual(walked);
    const d = __leadWalkDecodeCounters();
    expect(d.reused + d.decodes).toBe(5);
    // The walk's own rows are still alive (the test holds no strong ref, but no GC ran): nothing re-decoded.
    expect(d.decodes).toBeLessThanOrEqual(1);
  });

  it("concurrent held reads of a body share one decode and get the same rows", async () => {
    process.env.LEAD_WALK_HOLD_MS = "600000";
    const rows = [{ a: 1 }, { a: 2 }];
    await heldLeadWalk("k", async () => ({ rows: rows.map((r) => ({ ...r })), pages: 1 }));
    const results = await Promise.all([1, 2, 3].map(() => heldLeadWalk("k", async () => { throw new Error("must not walk"); })));
    for (const r of results) expect(r).toEqual(rows);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it("a decode is never reused across walks: a dropped or replaced walk decodes its own body", async () => {
    process.env.LEAD_WALK_HOLD_MS = "600000";
    const s = serveLeads(ROWS);
    const first = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    dropHeldLeadWalksForOrgs(["org-1"]);
    vi.restoreAllMocks();
    const changed = ROWS.map((r, i) => (i === 0 ? { ...r, clicked: true } : r));
    serveLeads(changed);
    const second = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    const third = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(s.pages()).toBe(3);
    expect(second).not.toEqual(first);
    expect(third).toEqual(second);
  });
});
