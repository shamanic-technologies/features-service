import { describe, it, expect, vi, afterEach } from "vitest";

// Read at module load by leads-client — set before the import below.
process.env.LEAD_SERVICE_URL = "http://lead:3000";
process.env.LEAD_SERVICE_API_KEY = "lead-key";
process.env.LEAD_PAGE_SIZE = "2";
process.env.LEAD_READ_CONCURRENCY = "2";

const { fetchLeadsForRevenue, __leadReadsInFlight } = await import("./leads-client.js");
const { createSlotLimiter } = await import("./concurrency.js");
const { fetchWithRetry } = await import("./fetch-retry.js");

const HEADERS = { orgId: "org-1" };

function row(id: string): Record<string, unknown> {
  return { leadId: id, campaignId: "c1", email: `${id}@acme.com`, contacted: true, lead: { firstName: id } };
}

function page(rows: Record<string, unknown>[], nextCursor: string | null): Response {
  return new Response(JSON.stringify({ leads: rows, nextCursor }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("a whole-population lead read is WALKED, not asked for in one body", () => {
  afterEach(() => vi.restoreAllMocks());

  it("walks every page with the producer's cursor and returns the COMPLETE population, in order", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      if (!url.includes("cursor=")) return page([row("l1"), row("l2")], "cur-1");
      if (url.includes("cursor=cur-1")) return page([row("l3"), row("l4")], "cur-2");
      return page([row("l5")], null);
    });

    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);

    // Same rows the unbounded read returned, same order — nothing about what is computed moved.
    expect(persons.map((p) => p.leadId)).toEqual(["l1", "l2", "l3", "l4", "l5"]);
    expect(urls).toHaveLength(3);
    // Every request is BOUNDED: the whole point is that abandoning one costs the downstream one page.
    expect(urls.every((u) => u.includes("limit=2"))).toBe(true);
    expect(urls[1]).toContain("cursor=cur-1");
    expect(urls[2]).toContain("cursor=cur-2");
  });

  it("a producer that never advances FAILS LOUD rather than looping or truncating", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => page([row("l1")], "stuck"));

    await expect(fetchLeadsForRevenue("brand-1", undefined, HEADERS)).rejects.toThrow(/repeating cursor/);
  });

  it("a page failure fails the whole walk — never a partial population reported as complete", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? page([row("l1"), row("l2")], "cur-1") : new Response("boom", { status: 500 });
    });

    await expect(fetchLeadsForRevenue("brand-1", undefined, HEADERS)).rejects.toThrow(/lead-service \/orgs\/leads failed \(500\)/);
  });

  it("a response with no cursor at all is one page, ended — the producer says it reached the end", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ leads: [row("l1")] }), { status: 200 }));

    const persons = await fetchLeadsForRevenue("brand-1", undefined, HEADERS);
    expect(persons.map((p) => p.leadId)).toEqual(["l1"]);
  });
});

describe("the fan-out cannot consume lead-service's capacity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("caps IN-FLIGHT page reads process-wide, however many independent call sites are walking", async () => {
    // Ten simultaneous whole-population reads is what took lead-service down. Each is a DIFFERENT
    // brand, so the in-flight dedup does not apply and every one of them genuinely wants the wire.
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started += 1;
      peak = Math.max(peak, __leadReadsInFlight());
      // Hold every read open until all the ones that CAN start have started.
      await gate;
      return page([row("l1")], null);
    });

    const walks = Promise.all(
      Array.from({ length: 10 }, (_, i) => fetchLeadsForRevenue(`brand-${i}`, undefined, HEADERS)),
    );
    // Let the admitted reads reach the wire and block.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(2);
    release!();
    await walks;

    expect(peak).toBeLessThanOrEqual(2);
    // Everyone still got served — the cap paces the reads, it never drops one.
    expect(started).toBe(10);
    expect(__leadReadsInFlight()).toBe(0);
  });

  it("releases its slot when a read FAILS, so one failure cannot wedge the cap shut", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("boom", { status: 500 }));

    await expect(fetchLeadsForRevenue("brand-x", undefined, HEADERS)).rejects.toThrow();
    expect(__leadReadsInFlight()).toBe(0);
  });
});

describe("createSlotLimiter", () => {
  it("never exceeds the cap, even when a waiter and a fresh caller race for the same freed slot", async () => {
    const limiter = createSlotLimiter(1);
    let peak = 0;
    let active = 0;
    const task = async () => limiter.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 0));
      active -= 1;
    });

    const first = task();
    const queued = task();
    // A caller arriving in the same tick as the hand-over must not steal the woken waiter's slot.
    const late = task();
    await Promise.all([first, queued, late]);

    expect(peak).toBe(1);
    expect(limiter.inFlight).toBe(0);
  });

  it("refuses a non-positive cap rather than running unbounded", () => {
    expect(() => createSlotLimiter(0)).toThrow(/positive integer/);
  });
});

describe("abandoning a read CANCELS it", () => {
  afterEach(() => vi.restoreAllMocks());

  it("aborts the request at the timeout instead of leaving the downstream working for nobody", async () => {
    const seen: Array<AbortSignal | undefined | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal ?? null;
      seen.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await expect(fetchWithRetry("http://lead:3000/orgs/leads", {}, { timeoutMs: 5 })).rejects.toThrow(/aborted/);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(true);
  });

  it("mints a FRESH signal per attempt, so a retry is not born already-aborted", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signals.push((init as RequestInit).signal as AbortSignal);
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      return new Response("ok", { status: 200 });
    });

    const res = await fetchWithRetry("http://lead:3000/orgs/leads", {}, { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1].aborted).toBe(false);
  });

  it("leaves a caller with no timeout exactly as it was — no signal invented", async () => {
    let seenInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seenInit = init as RequestInit;
      return new Response("ok", { status: 200 });
    });

    await fetchWithRetry("http://sibling/x", { headers: { a: "b" } });
    expect(seenInit?.signal).toBeUndefined();
  });
});
