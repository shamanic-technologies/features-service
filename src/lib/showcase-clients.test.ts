/**
 * THE HOMEPAGE PICK (owner 2026-11-07, SHOWCASE-MAX-1107): the 3 clients with the MOST meetings booked,
 * ties and fill broken by the most positive replies, whenever they began. Never 1 card while 3 clients
 * have outcomes, never a website-visit-only client, never a staff test client (route test).
 *
 * The shapes are production's, read 2026-11-07: obra.cam (1 positive reply, 0 meetings) stood alone on
 * the hero while Doc Dinners (meetings + 20 positive replies) and Shockwave (8 positive replies) existed.
 */
import { describe, it, expect } from "vitest";
import {
  buildShowcaseCandidates,
  isStaffOnlyBrand,
  isStaffOnlyOrg,
  pickByMostMeetings,
  pickShowcaseClients,
  SHOWCASE_GROUP_SIZE,
  walkComplete,
  type ShowcaseCandidate,
  furthestRungReached,
} from "./showcase-clients.js";

const DOC = "brand-doc";
const SHOCK = "brand-shock";
const OBRA = "brand-obra";
const LAB = "brand-lab";
/** Website visits only: a rung reached, no meeting, no positive reply. */
const VISITS = "brand-visits";

const cand = (brandId: string, meetingsBooked: number | null, positiveReplies: number | null, outcomeCount: number | null = 1): ShowcaseCandidate => ({
  brandId,
  meetingsBooked,
  positiveReplies,
  outcomeCount,
});

const CANDIDATES: ShowcaseCandidate[] = [
  cand(OBRA, 0, 1),
  cand(SHOCK, 0, 8),
  cand(VISITS, 0, 0, 12),
  cand(DOC, 3, 20),
  cand(LAB, 1, 64),
];

const ids = (g: { brandIds: string[] }) => g.brandIds;

describe("pickShowcaseClients (SHOWCASE-MAX-1107)", () => {
  it("orders by MOST meetings booked, then most positive replies: the biggest figures first", () => {
    const picks = pickShowcaseClients(CANDIDATES);
    expect(ids(picks.recentlyStarted)).toEqual([DOC, LAB, SHOCK]);
    expect(picks.recentlyStarted.rankedBrandIds).toEqual([DOC, LAB, SHOCK, OBRA]);
    expect(picks.recentlyStarted.requestedCount).toBe(SHOWCASE_GROUP_SIZE);
  });

  it("fills to 3 from positive-reply clients when fewer than 3 booked a meeting, and 1 positive reply is never shown while a bigger client exists", () => {
    const picks = pickShowcaseClients([cand(OBRA, 0, 1), cand(SHOCK, 0, 8), cand(DOC, 3, 20), cand(LAB, 0, 2)]);
    expect(ids(picks.recentlyStarted)).toEqual([DOC, SHOCK, LAB]);
    expect(ids(picks.recentlyStarted)).not.toContain(OBRA);
  });

  it("is always 3 when 3 clients have an outcome, whenever they began (no recency, no floor)", () => {
    const picks = pickShowcaseClients([cand("a", 0, 1), cand("b", 0, 1), cand("c", 0, 1)]);
    expect(ids(picks.recentlyStarted)).toHaveLength(3);
  });

  it("website visits alone never qualify, and a client counted at 0 and 0 is never walked", () => {
    const picks = pickShowcaseClients(CANDIDATES);
    expect(picks.recentlyStarted.rankedBrandIds).not.toContain(VISITS);
    expect(picks.recentlyStarted.qualifyingCount).toBe(4);
  });

  it("a client whose counts are UNKNOWN (an old snapshot row) is walked after every known one, biggest rung first", () => {
    const picks = pickShowcaseClients([cand("old-small", null, null, 2), cand(OBRA, 0, 1), cand("old-big", null, null, 50), cand("old-zero", null, null, 0)]);
    expect(picks.recentlyStarted.rankedBrandIds).toEqual([OBRA, "old-big", "old-small"]);
  });

  it("ties are broken by the brand id, so the row never wobbles between reads", () => {
    const tied = [cand("b", 2, 5), cand("a", 2, 5)];
    expect(ids(pickShowcaseClients(tied).recentlyStarted)).toEqual(["a", "b"]);
    expect(ids(pickShowcaseClients([...tied].reverse()).recentlyStarted)).toEqual(["a", "b"]);
  });

  it("names WHICH silence an empty group is", () => {
    expect(pickShowcaseClients(null).recentlyStarted).toMatchObject({ measured: false, unmeasuredReason: "no_snapshot_yet", brandIds: [] });
    expect(pickShowcaseClients([cand(VISITS, 0, 0)]).recentlyStarted).toMatchObject({ measured: false, unmeasuredReason: "no_qualifying_clients", qualifyingCount: 0 });
  });
});

describe("pickByMostMeetings (the walked counts the cards print)", () => {
  const c = (brandId: string, meetingsBooked: number | null, positiveReplies: number | null) => ({ brandId, meetingsBooked, positiveReplies });

  it("most meetings first, then most positive replies, website visits rejected", () => {
    const v = pickByMostMeetings([c("reply", 0, 3), c("one-meet", 1, 7), c("visits", 0, 0), c("three-meet", 3, 2), c("big-reply", 0, 40)]);
    expect(v.brandIds).toEqual(["three-meet", "one-meet", "big-reply"]);
    expect(v.rejected).toBe(1);
    expect(v.qualifying).toBe(4);
  });

  it("an uncounted client never qualifies", () => {
    const v = pickByMostMeetings([c("unknown", null, null)]);
    expect(v.brandIds).toEqual([]);
    expect(v.rejected).toBe(1);
  });
});

describe("walkComplete", () => {
  const c = (brandId: string, meetingsBooked: number, positiveReplies: number) => ({ brandId, meetingsBooked, positiveReplies });
  const full = pickByMostMeetings([c("a", 5, 10), c("b", 3, 10), c("c", 1, 4)]);

  it("is not complete while fewer than 3 walked clients qualify", () => {
    expect(walkComplete(pickByMostMeetings([c("a", 5, 10)]), undefined)).toBe(false);
  });

  it("keeps walking while the next candidate's snapshot could displace the third pick", () => {
    expect(walkComplete(full, cand("next", 2, 0))).toBe(false);
    expect(walkComplete(full, cand("next", 1, 9))).toBe(false);
  });

  it("stops when the next candidate cannot beat the third, or its counts are unknown", () => {
    expect(walkComplete(full, cand("next", 1, 4))).toBe(true);
    expect(walkComplete(full, cand("next", 0, 50))).toBe(true);
    expect(walkComplete(full, cand("next", null, null))).toBe(true);
    expect(walkComplete(full, undefined)).toBe(true);
  });
});

describe("buildShowcaseCandidates", () => {
  it("one client across two channels: the counts sum", () => {
    const [c] = buildShowcaseCandidates([
      [{ brandId: DOC, outcomeCount: 2, meetingsBooked: 1, positiveReplies: 4 }],
      [{ brandId: DOC, outcomeCount: 5, meetingsBooked: 2, positiveReplies: null }],
    ]);
    expect(c).toEqual({ brandId: DOC, outcomeCount: 7, meetingsBooked: 3, positiveReplies: 4 });
  });

  it("a row stored before the counts existed reads as unknown (null), never 0", () => {
    const [legacy] = buildShowcaseCandidates([[{ brandId: DOC }]]);
    expect(legacy).toEqual({ brandId: DOC, outcomeCount: null, meetingsBooked: null, positiveReplies: null });
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

describe("isStaffOnlyBrand (staff orgs never named on the homepage)", () => {
  it("the owner's test user kevin@pressbeat.io is staff", () => {
    expect(isStaffOnlyOrg(["kevin@pressbeat.io"])).toBe(true);
  });

  it("a member-less org abstains: PressBeat (its test org + three empty orgs) is ours", () => {
    expect(isStaffOnlyBrand([[], ["kevin@pressbeat.io"], [], null])).toBe(true);
  });

  it("any org with a client member makes the brand a client; all-empty is not called staff", () => {
    expect(isStaffOnlyBrand([["kevin@distribute.you"], ["founder@client.com"]])).toBe(false);
    expect(isStaffOnlyBrand([[], null])).toBe(false);
    // GrowthAgency.dev shape: one staff member and members with no email on record stay a client.
    expect(isStaffOnlyBrand([["", "kevin.lourd@gmail.com", ""]])).toBe(false);
  });
});
