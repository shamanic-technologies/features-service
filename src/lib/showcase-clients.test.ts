/**
 * THE HOMEPAGE PICK (recently started clients), over candidates built so the gates each exclude a
 * client the order would otherwise name. The best-return group is deleted (ROI-CONSISTENCY-1103).
 *
 * The numbers are production's shape, read 2026-09-22 off the cold-email snapshot.
 */
import { describe, it, expect } from "vitest";
import {
  buildShowcaseCandidates,
  isStaffOnlyOrg,
  pickRecentlyStartedByMeetings,
  pickShowcaseClients,
  SHOWCASE_GROUP_SIZE,
  type ShowcaseCandidate,
  furthestRungReached,
} from "./showcase-clients.js";

const DOC = "brand-doc";
const OPS = "brand-ops";
const SHOCK = "brand-shock";
/** Never billed a first day we can read: no recency candidate. */
const TINY = "brand-tiny";
/** Began yesterday and has produced nothing — what the outcome gate exists to drop. */
const SILENT = "brand-silent";

const CANDIDATES: ShowcaseCandidate[] = [
  { brandId: DOC, startedOn: "2026-03-01", outcomeCount: 40 },
  { brandId: OPS, startedOn: "2026-06-01", outcomeCount: 12 },
  { brandId: SHOCK, startedOn: "2026-08-01", outcomeCount: 6 },
  { brandId: TINY, startedOn: null, outcomeCount: 5 },
  { brandId: SILENT, startedOn: "2026-09-15", outcomeCount: 0 },
];

const ids = (g: { brandIds: string[] }) => g.brandIds;

describe("pickShowcaseClients", () => {
  it("orders recency NEWEST-first and serves no return group", () => {
    const picks = pickShowcaseClients(CANDIDATES);
    expect(ids(picks.recentlyStarted)).toEqual([SHOCK, OPS, DOC]);
    expect(picks).not.toHaveProperty("highestReturn");
    expect(picks).not.toHaveProperty("minSpendUsd");
  });

  it("the OUTCOME gate drops the newest client, because it has produced nothing", () => {
    const picks = pickShowcaseClients(CANDIDATES);
    expect(ids(picks.recentlyStarted)).not.toContain(SILENT);
    // Give it ONE person on a rung and it leads: the hero row is decided after the walk (owner 2026-10-19).
    const withOne = CANDIDATES.map((c) => (c.brandId === SILENT ? { ...c, outcomeCount: 1 } : c));
    expect(pickShowcaseClients(withOne).recentlyStarted.brandIds[0]).toBe(SILENT);
  });

  it("an UNMEASURED outcome count is not an outcome — we cannot claim what we did not count", () => {
    const unknown = CANDIDATES.map((c) => (c.brandId === SHOCK ? { ...c, outcomeCount: null } : c));
    expect(ids(pickShowcaseClients(unknown).recentlyStarted)).toEqual([OPS, DOC]);
  });

  it("a client we cannot DATE is no recency candidate, and is never dated with a stand-in", () => {
    const undated = CANDIDATES.map((c) => (c.brandId === SHOCK ? { ...c, startedOn: null } : c));
    expect(ids(pickShowcaseClients(undated).recentlyStarted)).toEqual([OPS, DOC]);
  });

  it("cuts to the requested count while STATING how many qualified", () => {
    const picks = pickShowcaseClients(CANDIDATES, 2);
    expect(ids(picks.recentlyStarted)).toEqual([SHOCK, OPS]);
    expect(picks.recentlyStarted.requestedCount).toBe(2);
    expect(picks.recentlyStarted.qualifyingCount).toBe(3);
  });

  it("a SHORT group is a stated fact, not an empty one", () => {
    const picks = pickShowcaseClients([CANDIDATES[0], CANDIDATES[3]]);
    expect(ids(picks.recentlyStarted)).toEqual([DOC]);
    expect(picks.recentlyStarted.measured).toBe(true);
    expect(picks.recentlyStarted.qualifyingCount).toBe(1);
    expect(picks.recentlyStarted.requestedCount).toBe(SHOWCASE_GROUP_SIZE);
  });

  it("the two silences are DIFFERENT statements", () => {
    expect(pickShowcaseClients(null).recentlyStarted).toMatchObject({ measured: false, unmeasuredReason: "no_snapshot_yet", brandIds: [] });
    const thin = pickShowcaseClients([CANDIDATES[3]]);
    expect(ids(thin.recentlyStarted)).toEqual([]);
    expect(thin.recentlyStarted.unmeasuredReason).toBe("no_qualifying_clients");
  });

  it("the order is TOTAL, so identical evidence always names the same clients in the same order", () => {
    const tied: ShowcaseCandidate[] = [
      { brandId: "b", startedOn: "2026-05-01", outcomeCount: 5 },
      { brandId: "a", startedOn: "2026-05-01", outcomeCount: 5 },
    ];
    expect(ids(pickShowcaseClients(tied).recentlyStarted)).toEqual(["a", "b"]);
    expect(ids(pickShowcaseClients([...tied].reverse()).recentlyStarted)).toEqual(["a", "b"]);
  });
});

describe("buildShowcaseCandidates", () => {
  it("a client on TWO channels is ONE client: its beginning is the EARLIER, its rungs sum", () => {
    const [c] = buildShowcaseCandidates([
      [{ brandId: DOC, startedOn: "2026-06-01", outcomeCount: 2 }],
      [{ brandId: DOC, startedOn: "2026-02-01", outcomeCount: 5 }],
    ]);
    expect(c).toEqual({ brandId: DOC, startedOn: "2026-02-01", outcomeCount: 7 });
  });

  it("a row with no pick fields narrows to nulls rather than to zeros, and is named by nobody", () => {
    const [legacy] = buildShowcaseCandidates([[{ brandId: DOC }]]);
    expect(legacy.startedOn).toBeNull();
    expect(legacy.outcomeCount).toBeNull();
    expect(pickShowcaseClients([legacy]).recentlyStarted.unmeasuredReason).toBe("no_qualifying_clients");
  });

  it("a MEASURED 0 outcome count survives the fold and is not an absence", () => {
    const [c] = buildShowcaseCandidates([[{ brandId: DOC, outcomeCount: 0 }]]);
    expect(c.outcomeCount).toBe(0);
  });
});

// ── AN OUTCOME IS A RUNG PAST THE BASE ────────────────────────────────────────────────────────────
//
// Both helpers assert the DIVERGENCE between "somebody was contacted" and "the funnel produced
// something": a helper that read the outreach base, or counted an unmeasured rung, would pass a suite
// that only checked a number came back — and would name the Living Vital shape again.

describe("furthestRungReached", () => {
  const step = (recipientsReached: number | null) => ({ recipientsReached }) as never;
  const breakdown = (steps: Array<number | null>, contactedRecipients = 183) =>
    ({ contactedRecipients, convertibleRecipients: contactedRecipients, steps: steps.map(step) }) as never;

  it("never reads the outreach base: 183 contacted and 0 on every rung is 0, not 183", () => {
    expect(furthestRungReached(breakdown([0, 0, 0, 0]))).toBe(0);
  });

  it("takes the furthest-reached rung's count", () => {
    expect(furthestRungReached(breakdown([51, 0, 0]))).toBe(51);
    expect(furthestRungReached(breakdown([1, 3, 0]))).toBe(3);
  });

  it("an unmeasured rung is skipped, and all-unmeasured or nothing walked is null — never 0", () => {
    expect(furthestRungReached(breakdown([null, 0]))).toBe(0);
    expect(furthestRungReached(breakdown([null, null]))).toBeNull();
    expect(furthestRungReached(null)).toBeNull();
    expect(furthestRungReached(undefined)).toBeNull();
  });
});

describe("pickRecentlyStartedByMeetings (owner 2026-10-19, SHOWCASE-MEETINGS-1019)", () => {
  const c = (brandId: string, meetingsBooked: number | null, positiveReplies: number | null) => ({
    brandId,
    meetingsBooked,
    positiveReplies,
  });

  it("names meeting clients first, newest first, then fills with positive-reply clients", () => {
    const v = pickRecentlyStartedByMeetings([c("new-reply", 0, 3), c("mid-meet", 1, 7), c("visits", 0, 0), c("old-meet", 3, 2)]);
    expect(v.brandIds).toEqual(["mid-meet", "old-meet", "new-reply"]);
    expect(v.rejected).toBe(1);
    expect(v.complete).toBe(false);
  });

  it("is complete once 3 meeting clients are found, and a reply client never displaces one", () => {
    const v = pickRecentlyStartedByMeetings([c("a", 1, 1), c("r", 0, 50), c("b", 2, 0), c("d", 1, null)]);
    expect(v.brandIds).toEqual(["a", "b", "d"]);
    expect(v.complete).toBe(true);
  });

  it("website visits alone or an uncounted client never qualifies", () => {
    const v = pickRecentlyStartedByMeetings([c("visits", 0, 0), c("unknown", null, null)]);
    expect(v.brandIds).toEqual([]);
    expect(v.rejected).toBe(2);
  });
});

describe("isStaffOnlyOrg (staff test org, billing-service's rule)", () => {
  it("is a staff test org only when EVERY member is staff, plus-addressing ignored", () => {
    expect(isStaffOnlyOrg(["kevin@distribute.you", "kevin.lourd+e2eclient1014@gmail.com"])).toBe(true);
    expect(isStaffOnlyOrg(["kevin@distribute.you", "founder@client.com"])).toBe(false);
  });

  it("an org with no member, or one client-service does not know, is not called staff", () => {
    expect(isStaffOnlyOrg([])).toBe(false);
    expect(isStaffOnlyOrg(null)).toBe(false);
    // GrowthAgency.dev, prod 2026-10-19: one staff member and six with no email on record.
    expect(isStaffOnlyOrg(["", "", "kevin.lourd@gmail.com", ""])).toBe(false);
  });
});
