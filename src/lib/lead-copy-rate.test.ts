/**
 * BOX-LOAD-1028-FEATURES-LEADREADS: a lead-service change feed is opened only for a scope read often enough
 * to pay for it (a warm feed is re-read whole every 3 min for 30 min after each read); every other read walks,
 * a fleet read takes a live copy synced inside the hold window without asking lead-service, and every path
 * returns the same persons.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.LEAD_PAGE_SIZE = "2";

const { fetchLeadsForRevenue } = await import("./leads-client.js");
const { __resetLeadWalkHold } = await import("./lead-walk-hold.js");
const { withLiveLeadCopy, __resetLeadCopies, liveCopyPaysFor, liveCopyCounters, LEAD_COPY_OPEN_READS } = await import("./lead-copy.js");

const HEADERS = { orgId: "org-1", userId: "u1", runId: "r1" };

function row(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `lc-${i}`,
    leadId: `l${i}`,
    campaignId: `c${i % 2}`,
    workflowSlug: "wf-a",
    lastServedAt: `2026-10-0${i}T10:00:00.000Z`,
    audienceId: "aud-1",
    email: `p${i}@acme${i}.com`,
    contacted: true,
    sent: true,
    delivered: true,
    clicked: i % 2 === 0,
    bounced: false,
    unsubscribed: false,
    replied: i === 1,
    replyClassification: i === 1 ? "positive" : null,
    crmPositiveReplyAt: null,
    lead: { firstName: `F${i}`, lastName: null, photoUrl: null, currentTitle: "VP", seniority: "vp", country: "FR", organization: null },
    ...over,
  };
}

/** lead-service fake: `/orgs/leads` paged walk and `/orgs/leads/changes` (snapshot, then deltas), over the SAME rows. */
function serve(rowsRef: { rows: Record<string, unknown>[] }) {
  const counts = { pages: 0, feedReads: 0 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    if (url.pathname.startsWith("/internal/users")) return new Response(JSON.stringify({ users: [] }), { status: 200 });
    if (url.pathname === "/orgs/leads/changes") {
      counts.feedReads += 1;
      // Always the whole scope (a valid answer: full replaces the copy) — what matters here is that it was asked.
      return new Response(JSON.stringify({ full: true, cursor: `v${counts.feedReads}`, leads: rowsRef.rows, removed: [] }), { status: 200 });
    }
    if (url.pathname !== "/orgs/leads") throw new Error(`unexpected ${url}`);
    counts.pages += 1;
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const size = Number(url.searchParams.get("limit"));
    const next = start + size < rowsRef.rows.length ? String(start + size) : null;
    return new Response(JSON.stringify({ leads: rowsRef.rows.slice(start, start + size), nextCursor: next }), { status: 200 });
  });
  return counts;
}

const byLead = <T extends { leadId: string }>(xs: T[]) => [...xs].sort((a, b) => a.leadId.localeCompare(b.leadId));

describe("live lead copy only for a scope read often enough (BOX-LOAD-1028-FEATURES-LEADREADS)", () => {
  let saved: { copy?: string; hold?: string };
  let now = Date.parse("2026-10-28T12:00:00.000Z");
  const advance = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  beforeEach(() => {
    saved = { copy: process.env.LEAD_COPY_ENABLED, hold: process.env.LEAD_WALK_HOLD_MS };
    delete process.env.LEAD_COPY_ENABLED;
    process.env.LEAD_WALK_HOLD_MS = "600000";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    __resetLeadCopies();
    __resetLeadWalkHold();
  });
  afterEach(() => {
    process.env.LEAD_COPY_ENABLED = saved.copy;
    process.env.LEAD_WALK_HOLD_MS = saved.hold;
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetLeadCopies();
    __resetLeadWalkHold();
  });

  it("a scope read once (a burst of cells of many brands) WALKS: no feed is opened for it", async () => {
    const data = { rows: [1, 2, 3].map((i) => row(i)) };
    const c = serve(data);
    for (const brand of ["b1", "b2", "b3", "b4"]) await withLiveLeadCopy(() => fetchLeadsForRevenue(brand, undefined, HEADERS));
    expect(c.feedReads).toBe(0);
    expect(c.pages).toBe(4 * 2);
    expect(liveCopyCounters.freshWalks).toBe(4);
  });

  it("the feed opens on the third read instant inside 6 min, and every read returns the same persons", async () => {
    const data = { rows: [1, 2, 3].map((i) => row(i)) };
    const c = serve(data);
    process.env.LEAD_WALK_HOLD_MS = "0";
    const walked = byLead(await fetchLeadsForRevenue("brand-1", undefined, HEADERS));
    process.env.LEAD_WALK_HOLD_MS = "600000";
    c.pages = 0;

    const reads = [];
    for (let n = 0; n < LEAD_COPY_OPEN_READS + 1; n++) {
      reads.push(byLead(await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS))));
      advance(2 * 60_000);
    }
    // Reads 1-2 walk (fresh each: 2 min apart, past the 30 s instant); reads 3-4 read the feed.
    expect(c.pages).toBe(2 * 2);
    expect(c.feedReads).toBe(2);
    for (const r of reads) expect(r).toEqual(walked);
  });

  it("reads inside one 30 s instant are ONE read: a compute reading its scope several times never opens a feed", async () => {
    const data = { rows: [1, 2, 3].map((i) => row(i)) };
    const c = serve(data);
    for (let n = 0; n < 6; n++) {
      await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS));
      advance(1_000);
    }
    expect(c.feedReads).toBe(0);
    // ...and the same instant reuses the walk it just took.
    expect(c.pages).toBe(2);
  });

  it("an interactive read never takes a walk older than 30 s: it walks fresh and sees a change", async () => {
    const data = { rows: [1, 2, 3].map((i) => row(i)) };
    const c = serve(data);
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS); // a fleet walk, held 10 min
    advance(60_000);
    data.rows = [1, 2, 3].map((i) => row(i, i === 3 ? { replied: true, replyClassification: "positive" } : {}));
    const persons = await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS));
    expect(c.pages).toBe(4);
    expect(persons.find((p) => p.leadId === "l3")!.signals.positiveReply).toBe(true);
  });

  it("the interactive walk is HELD: a fleet read right after asks lead-service nothing", async () => {
    const data = { rows: [1, 2, 3].map((i) => row(i)) };
    const c = serve(data);
    const interactive = await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS));
    advance(3 * 60_000);
    const fleet = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(c.pages).toBe(2);
    expect(fleet).toEqual(interactive);
  });

  it("a fleet read takes a live copy synced inside the hold window with no call, and walks once it is older", async () => {
    const data = { rows: [1, 2, 3].map((i) => row(i)) };
    const c = serve(data);
    for (let n = 0; n < LEAD_COPY_OPEN_READS; n++) {
      await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS));
      advance(60_000);
    }
    expect(c.feedReads).toBe(1);
    const pagesBefore = c.pages;
    // A fleet read 1 min after the copy synced (the interactive walks are held too, so drop them first).
    __resetLeadWalkHold();
    const fleet = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(c.pages).toBe(pagesBefore);
    expect(c.feedReads).toBe(1);
    expect(liveCopyCounters.fleetPeeks).toBe(1);
    expect(byLead(fleet)).toEqual(byLead(await withLiveLeadCopy(() => fetchLeadsForRevenue("brand-1", undefined, HEADERS))));
    // Past the 10-min window the copy is not served to a fleet read: it walks.
    advance(11 * 60_000);
    __resetLeadWalkHold();
    const feedReads = c.feedReads;
    await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(c.pages).toBe(pagesBefore + 2);
    expect(c.feedReads).toBe(feedReads);
  });

  it("liveCopyPaysFor: forgets read instants past the window", () => {
    const t0 = Date.parse("2026-10-28T00:00:00.000Z");
    expect(liveCopyPaysFor("k", t0)).toBe(false);
    expect(liveCopyPaysFor("k", t0 + 2 * 60_000)).toBe(false);
    expect(liveCopyPaysFor("k", t0 + 4 * 60_000)).toBe(true);
    // 7 min of silence: every earlier instant fell out of the 6-min window, only the new one counts.
    expect(liveCopyPaysFor("k", t0 + 11 * 60_000)).toBe(false);
  });
});
