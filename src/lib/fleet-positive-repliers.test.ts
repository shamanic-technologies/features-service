import { describe, it, expect, vi, beforeEach } from "vitest";

vi.unmock("./fleet-positive-repliers.js");
vi.mock("./feature-memberships-client.js", () => ({ fetchFeatureMemberships: vi.fn() }));
vi.mock("./crm-only-repliers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crm-only-repliers.js")>()),
  fetchScopePersons: vi.fn(),
}));

// The cell store (lib/fleet-cell-store.ts) is a Postgres row in prod; here an in-memory one.
const store = new Map<string, { text: string; computedAt: number; claimedAt: number | null }>();
let storeClaimHeldElsewhere = false;
vi.mock("./fleet-cell-store.js", () => ({
  loadFleetCell: vi.fn(async (key: string) => {
    const row = store.get(key);
    return row ? { text: row.text, computedAt: row.computedAt } : null;
  }),
  claimFleetCellBuild: vi.fn(async () => !storeClaimHeldElsewhere),
  storeFleetCell: vi.fn(async (key: string, text: string, computedAt: number) => {
    store.set(key, { text, computedAt, claimedAt: null });
  }),
}));

const { fetchFeatureMemberships } = await import("./feature-memberships-client.js");
const { fetchScopePersons } = await import("./crm-only-repliers.js");
const { fetchFleetPositiveRepliesBySlug, fetchFleetMatureSlugStats, __resetFleetPositiveRepliers, encodeCell, decodeCell } = await import(
  "./fleet-positive-repliers.js"
);

const replier = (leadId: string, workflowSlug: string | null) => ({ leadId, email: null, campaignId: null, workflowSlug, crmOnly: false });

/** One deduped person, as the fleet walk reads it. `servedAt` "unstated" = the producer states none. */
function person(
  leadId: string,
  workflowSlug: string | null,
  signals: { contacted?: boolean; clicked?: boolean; positiveReply?: boolean },
  servedAt: string | null | "unstated" = "2026-08-01T10:00:00.000Z",
  campaignId: string | null = "c-leg",
) {
  return {
    leadId,
    campaignId,
    workflowSlug,
    signals: { contacted: true, ...signals },
    ...(servedAt !== "unstated" ? { servedAt } : {}),
  };
}

// Two orgs, three brands; the requesting pair is (org-1, brand-own).
const MEMBERSHIPS = [
  { orgId: "org-1", brandId: "brand-own", workflowSlug: "wf-a" },
  { orgId: "org-1", brandId: "brand-own", workflowSlug: "wf-b" }, // same pair, second workflow row
  { orgId: "org-2", brandId: "brand-x", workflowSlug: "wf-a" },
  { orgId: "org-3", brandId: "brand-y", workflowSlug: "wf-b" },
];
const BY_PAIR: Record<string, ReturnType<typeof person>[]> = {
  "org-1:brand-own": [person("stale-1", "wf-a", { positiveReply: true })],
  "org-2:brand-x": [
    person("x1", "wf-a", { positiveReply: true }),
    person("x2", "wf-a", { positiveReply: true }, "2026-09-25T09:00:00.000Z"), // served YOUNG
    person("x3", null, { positiveReply: true }),
    person("x4", "wf-a", { clicked: true }, "2026-08-02T10:00:00.000Z", "c-other-leg"), // another leg's campaign
  ],
  "org-3:brand-y": [person("y1", "wf-b", { positiveReply: true })],
};

const CUTOFF = "2026-09-07T00:00:00.000Z";

beforeEach(() => {
  __resetFleetPositiveRepliers();
  store.clear();
  storeClaimHeldElsewhere = false;
  vi.mocked(fetchFeatureMemberships).mockReset().mockResolvedValue(MEMBERSHIPS);
  vi.mocked(fetchScopePersons)
    .mockReset()
    .mockImplementation(async (brandId, _scope, identity) => BY_PAIR[`${identity.orgId}:${brandId}`] as any);
});

describe("fetchFleetPositiveRepliesBySlug", () => {
  it("sums every other pair's PERSON count per slug and adds the requesting pair's LIVE repliers", async () => {
    const live = [replier("o1", "wf-a"), replier("o2", "wf-a"), replier("o3", "wf-b")];
    const fleet = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", { orgId: "org-1", brandId: "brand-own", repliers: live as any });
    // wf-a: brand-x 2 + own live 2 (the cached "stale-1" is replaced, never added) ; wf-b: brand-y 1 + own 1.
    expect(Object.fromEntries(fleet)).toEqual({ "wf-a": 4, "wf-b": 2 });
    // Each pair walked once (the duplicate membership row did not cause a second walk), org-only identity.
    expect(vi.mocked(fetchScopePersons)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetchScopePersons)).toHaveBeenCalledWith("brand-x", undefined, { orgId: "org-2" });
  });

  it("can never read below the requesting pair, even when the pair is not in the cell", async () => {
    const live = [replier("n1", "wf-c")];
    const fleet = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", { orgId: "org-9", brandId: "brand-new", repliers: live as any });
    expect(fleet.get("wf-c")).toBe(1);
  });

  it("serves the cell from memory on the next read (one fleet walk per fresh window)", async () => {
    const own = { orgId: "org-1", brandId: "brand-own", repliers: [] };
    await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    expect(vi.mocked(fetchFeatureMemberships)).toHaveBeenCalledTimes(1);
  });

  it("fails LOUD on a cold cell when one pair cannot be read — never a fleet total missing a brand", async () => {
    vi.mocked(fetchScopePersons).mockImplementation(async (brandId) => {
      if (brandId === "brand-y") throw new Error("lead-service down");
      return [] as any;
    });
    await expect(
      fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", { orgId: "org-1", brandId: "brand-own", repliers: [] }),
    ).rejects.toThrow("lead-service down");
  });
});

describe("fetchFleetMatureSlugStats — the fleet's mature cohort, on the SAME cell", () => {
  it("counts only persons SERVED before the cutoff, and the requesting pair from its LIVE persons", async () => {
    const own = [
      person("o1", "wf-a", { positiveReply: true }, "2026-08-10T00:00:00.000Z"),
      person("o2", "wf-a", { positiveReply: true }, "2026-09-20T00:00:00.000Z"), // young
    ];
    const stats = await fetchFleetMatureSlugStats(
      "sales-cold-email-outreach",
      { orgId: "org-1", brandId: "brand-own", persons: own as any },
      CUTOFF,
    );
    // wf-a: brand-x x1 (x2 is young) + x4 (a click) + own o1 (o2 young; stale-1 replaced).
    expect(stats!.get("wf-a")).toEqual({ recipientsContacted: 3, recipientsClicked: 1, recipientsRepliesPositive: 2 });
    expect(stats!.get("wf-b")).toEqual({ recipientsContacted: 1, recipientsClicked: 0, recipientsRepliesPositive: 1 });
    // THE DIVERGENCE: the flash reply count for wf-a counts the young x2 and o2 as well.
    const flash = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", {
      orgId: "org-1",
      brandId: "brand-own",
      repliers: own.filter((p) => p.signals.positiveReply).map((p) => replier(p.leadId, p.workflowSlug)) as any,
    });
    expect(flash.get("wf-a")).toBe(4);
  });

  it("narrows to the leg's campaigns", async () => {
    const stats = await fetchFleetMatureSlugStats(
      "sales-cold-email-outreach",
      { orgId: "org-1", brandId: "brand-own", persons: [] },
      CUTOFF,
      new Set(["c-leg"]),
    );
    // x4 sat on another leg's campaign: its click is gone.
    expect(stats!.get("wf-a")).toEqual({ recipientsContacted: 1, recipientsClicked: 0, recipientsRepliesPositive: 1 });
  });

  it("is NULL when a pair's rows state no serve date — never the flash figure under the mature name", async () => {
    vi.mocked(fetchScopePersons).mockImplementation(async (brandId, _scope, identity) =>
      brandId === "brand-y" ? ([person("y1", "wf-b", { positiveReply: true }, "unstated")] as any) : (BY_PAIR[`${identity.orgId}:${brandId}`] as any),
    );
    const stats = await fetchFleetMatureSlugStats(
      "sales-cold-email-outreach",
      { orgId: "org-1", brandId: "brand-own", persons: [] },
      CUTOFF,
    );
    expect(stats).toBeNull();
  });

  it("with NO requesting pair (a fleet read), every pair comes from the cell", async () => {
    const stats = await fetchFleetMatureSlugStats("sales-cold-email-outreach", null, CUTOFF);
    // wf-a: the cached own row stale-1 (served 08-01, a reply) + brand-x x1 + x4 (a click); x2 is young.
    expect(stats!.get("wf-a")).toEqual({ recipientsContacted: 3, recipientsClicked: 1, recipientsRepliesPositive: 2 });
    expect(stats!.get("wf-b")).toEqual({ recipientsContacted: 1, recipientsClicked: 0, recipientsRepliesPositive: 1 });
  });

  it("is NULL when the requesting pair's own live rows state no serve date", async () => {
    const stats = await fetchFleetMatureSlugStats(
      "sales-cold-email-outreach",
      { orgId: "org-1", brandId: "brand-own", persons: [person("o1", "wf-a", { positiveReply: true }, "unstated")] as any },
      CUTOFF,
    );
    expect(stats).toBeNull();
  });
});

describe("the stored fleet cell (one build shared by every process and every boot)", () => {
  const own = { orgId: "org-1", brandId: "brand-own", repliers: [replier("o1", "wf-a")] as any };

  it("round-trips a cell exactly", () => {
    const cell = {
      computedAt: 1_760_000_000_000,
      byPair: new Map([
        ["org-2:brand-x", { serveDatesStated: true, buckets: new Map<string, [number, number, number]>([["c\twf-a\t2026-08-01", [3, 1, 2]], ["\t\t", [1, 0, 0]]]) }],
        ["org-3:brand-y", { serveDatesStated: false, buckets: new Map<string, [number, number, number]>() }],
      ]),
    };
    expect(decodeCell(encodeCell(cell))).toEqual(cell);
  });

  it("a new process starts from the stored cell: no fleet walk, the same figures", async () => {
    const first = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    const firstMature = await fetchFleetMatureSlugStats("sales-cold-email-outreach", null, CUTOFF);
    expect(vi.mocked(fetchScopePersons)).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(1);

    __resetFleetPositiveRepliers(); // a deploy / the other process: nothing in memory
    vi.mocked(fetchScopePersons).mockClear();
    const again = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    const againMature = await fetchFleetMatureSlugStats("sales-cold-email-outreach", null, CUTOFF);
    expect(vi.mocked(fetchScopePersons)).not.toHaveBeenCalled();
    expect(again).toEqual(first);
    expect(againMature).toEqual(firstMature);
  });

  it("a stale cell another process is rebuilding is served as held, without a walk here", async () => {
    await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    const key = [...store.keys()][0];
    __resetFleetPositiveRepliers();
    store.set(key, { ...store.get(key)!, computedAt: Date.now() - 20 * 60_000 }); // past the 15 min fresh window
    storeClaimHeldElsewhere = true;
    vi.mocked(fetchScopePersons).mockClear();
    const fleet = await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(fetchScopePersons)).not.toHaveBeenCalled();
    expect(Object.fromEntries(fleet)).toEqual({ "wf-a": 3, "wf-b": 1 });
  });

  it("with nothing stored and nothing held, a read still builds (and stores) the cell", async () => {
    storeClaimHeldElsewhere = true;
    await fetchFleetPositiveRepliesBySlug("sales-cold-email-outreach", own);
    expect(vi.mocked(fetchScopePersons)).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(1);
  });
});
