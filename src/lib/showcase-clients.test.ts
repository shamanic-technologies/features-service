/**
 * THE TWO HOMEPAGE PICKS, over ONE set of candidates built to make the rankings DISAGREE.
 *
 * Every case asserts a DIVERGENCE rather than "a list came back": the recency order and the return
 * order name the same clients in opposite sequences, the floor and the outcome gate each exclude a
 * client the other would have kept, and the two silences answer different reasons. A suite that only
 * checked "three brand ids came out" would pass on an implementation that ranked one way twice — which
 * is the thing this exists not to do.
 *
 * The numbers are production's, read 2026-09-22 off the cold-email snapshot, so the sub-floor case is
 * the shape the unfiltered ranking really leads with rather than one invented to be convenient.
 */
import { describe, it, expect } from "vitest";
import {
  buildShowcaseCandidates,
  pickShowcaseClients,
  SHOWCASE_GROUP_SIZE,
  type ShowcaseCandidate,
  furthestRungReached,
  showcaseChainHasOutcome,
} from "./showcase-clients.js";
import type { BrandReturnRow } from "./fleet-return-on-spend.js";

const DOC = "brand-doc";
const OPS = "brand-ops";
const SHOCK = "brand-shock";
/**
 * 21.5x on $4.12 — the top of production's UNFILTERED ranking, and what the floor exists to drop.
 * It has never been billed a first day we can read, so it is no recency candidate either.
 */
const TINY = "brand-tiny";
/** Began yesterday and has produced nothing — what the outcome gate exists to drop. */
const SILENT = "brand-silent";

const CANDIDATES: ShowcaseCandidate[] = [
  { brandId: DOC, committedSpendUsd: 5046.42, expectedPipelineUsd: 8250, startedOn: "2026-03-01", outcomeCount: 40 },
  { brandId: OPS, committedSpendUsd: 354.96, expectedPipelineUsd: 19750, startedOn: "2026-06-01", outcomeCount: 12 },
  { brandId: SHOCK, committedSpendUsd: 497.65, expectedPipelineUsd: 1800, startedOn: "2026-08-01", outcomeCount: 3 },
  { brandId: TINY, committedSpendUsd: 4.12, expectedPipelineUsd: 88.74, startedOn: null, outcomeCount: 1 },
  { brandId: SILENT, committedSpendUsd: 900, expectedPipelineUsd: 1200, startedOn: "2026-09-15", outcomeCount: 0 },
];

const FLOOR = 100;
const ids = (g: { brandIds: string[] }) => g.brandIds;

describe("pickShowcaseClients", () => {
  it("orders recency NEWEST-first and return BEST-first, and the two orders DISAGREE", () => {
    const picks = pickShowcaseClients(CANDIDATES, FLOOR);

    expect(ids(picks.recentlyStarted)).toEqual([SHOCK, OPS, DOC]);
    // The SAME three clients, in a different sequence: 55.6x / 3.6x / 1.63x. First of one is second of
    // the other, so one list served twice cannot satisfy both.
    expect(ids(picks.highestReturn)).toEqual([OPS, SHOCK, DOC]);
    expect(ids(picks.recentlyStarted)).not.toEqual(ids(picks.highestReturn));
  });

  it("the SPEND FLOOR drops the 22x that rests on $4, and it CHANGES who is named", () => {
    const floored = pickShowcaseClients(CANDIDATES, FLOOR);
    expect(ids(floored.highestReturn)).toEqual([OPS, SHOCK, DOC]);
    expect(ids(floored.highestReturn)).not.toContain(TINY);

    // Drop the floor and the $4 client takes SECOND place, pushing a client with real money behind
    // its number off the list entirely. That displacement is production's shape (2026-09-22: 21.5x on
    // $4.12 sat third, ahead of 17.7x on $247) and it is the divergence that proves the floor is doing
    // the work rather than the ordering happening to agree.
    const unfiltered = pickShowcaseClients(CANDIDATES, 0);
    expect(ids(unfiltered.highestReturn)).toEqual([OPS, TINY, SHOCK]);
    expect(ids(unfiltered.highestReturn)).not.toContain(DOC);
  });

  it("the floor is INCLUSIVE and is echoed back", () => {
    const exactly = [{ ...CANDIDATES[2], committedSpendUsd: FLOOR, expectedPipelineUsd: 200 }];
    const picks = pickShowcaseClients(exactly, FLOOR);
    expect(ids(picks.highestReturn)).toEqual([SHOCK]);
    expect(picks.minSpendUsd).toBe(FLOOR);
  });

  it("the OUTCOME gate drops the newest client, because it has produced nothing", () => {
    const picks = pickShowcaseClients(CANDIDATES, FLOOR);
    // SILENT began 2026-09-15 — later than every client named — and is absent.
    expect(ids(picks.recentlyStarted)).not.toContain(SILENT);
    expect(picks.recentlyStarted.brandIds[0]).toBe(SHOCK);

    // Give it ONE outcome and nothing else, and it leads. The gate is the only thing keeping it out.
    const withOne = CANDIDATES.map((c) => (c.brandId === SILENT ? { ...c, outcomeCount: 1 } : c));
    expect(pickShowcaseClients(withOne, FLOOR).recentlyStarted.brandIds[0]).toBe(SILENT);
  });

  it("an UNMEASURED outcome count is not an outcome — we cannot claim what we did not count", () => {
    const unknown = CANDIDATES.map((c) => (c.brandId === SHOCK ? { ...c, outcomeCount: null } : c));
    expect(ids(pickShowcaseClients(unknown, FLOOR).recentlyStarted)).toEqual([OPS, DOC]);
  });

  it("a client we cannot DATE is no recency candidate, and is never dated with a stand-in", () => {
    // The sub-floor client is already undated and already absent from the recency list; null one of
    // the clients that DOES lead it, and it leaves too.
    const undated = CANDIDATES.map((c) => (c.brandId === SHOCK ? { ...c, startedOn: null } : c));
    const picks = pickShowcaseClients(undated, FLOOR);
    expect(ids(picks.recentlyStarted)).toEqual([OPS, DOC]);
    // It still returns perfectly well — the missing date costs it ONE ranking, not the population.
    expect(ids(picks.highestReturn)).toContain(SHOCK);
  });

  it("a client whose pipeline we could not price is in NO return ranking, and is not a 0", () => {
    const unpriced = CANDIDATES.map((c) => (c.brandId === OPS ? { ...c, expectedPipelineUsd: null } : c));
    const picks = pickShowcaseClients(unpriced, FLOOR);
    expect(ids(picks.highestReturn)).toEqual([SHOCK, DOC, SILENT]);
    // A 0 would have ranked it LAST — a measurement nobody made. It is absent instead.
    expect(ids(picks.highestReturn)).not.toContain(OPS);
    // And it is still a recency candidate: the two rankings gate on different things.
    expect(ids(picks.recentlyStarted)).toContain(OPS);
  });

  it("cuts to the requested count while STATING how many qualified", () => {
    const picks = pickShowcaseClients(CANDIDATES, FLOOR, 2);
    expect(ids(picks.highestReturn)).toEqual([OPS, SHOCK]);
    expect(picks.highestReturn.requestedCount).toBe(2);
    // Four clients passed the floor; the cut is a display decision, not a narrowing of the population.
    expect(picks.highestReturn.qualifyingCount).toBe(4);
  });

  it("a SHORT group is a stated fact, not an empty one", () => {
    const picks = pickShowcaseClients([CANDIDATES[0], CANDIDATES[3]], FLOOR);
    expect(ids(picks.highestReturn)).toEqual([DOC]);
    expect(picks.highestReturn.measured).toBe(true);
    expect(picks.highestReturn.qualifyingCount).toBe(1);
    expect(picks.highestReturn.requestedCount).toBe(SHOWCASE_GROUP_SIZE);
  });

  it("the two silences are DIFFERENT statements", () => {
    // No snapshot at all — there was nothing to rank.
    const cold = pickShowcaseClients(null, FLOOR);
    expect(cold.recentlyStarted).toMatchObject({ measured: false, unmeasuredReason: "no_snapshot_yet", brandIds: [] });
    expect(cold.highestReturn.unmeasuredReason).toBe("no_snapshot_yet");

    // A snapshot exists and nobody passes — something to say, and a different thing.
    const thin = pickShowcaseClients([CANDIDATES[3]], FLOOR);
    expect(thin.highestReturn.unmeasuredReason).toBe("no_qualifying_clients");
    expect(thin.highestReturn.qualifyingCount).toBe(0);
    // It fails the recency gate too, for its OWN reason — we cannot date it — so both groups answer
    // the same word here off two different gates.
    expect(ids(thin.recentlyStarted)).toEqual([]);
    expect(thin.recentlyStarted.unmeasuredReason).toBe("no_qualifying_clients");
  });

  it("both orders are TOTAL, so identical evidence always names the same clients in the same order", () => {
    const tied: ShowcaseCandidate[] = [
      { brandId: "b", committedSpendUsd: 200, expectedPipelineUsd: 400, startedOn: "2026-05-01", outcomeCount: 1 },
      { brandId: "a", committedSpendUsd: 500, expectedPipelineUsd: 1000, startedOn: "2026-05-01", outcomeCount: 1 },
    ];
    // Same ratio, same day — the brand id breaks both ties, so neither list can wobble between reads.
    expect(ids(pickShowcaseClients(tied, FLOOR).highestReturn)).toEqual(["a", "b"]);
    expect(ids(pickShowcaseClients(tied, FLOOR).recentlyStarted)).toEqual(["a", "b"]);
    expect(ids(pickShowcaseClients([...tied].reverse(), FLOOR).highestReturn)).toEqual(["a", "b"]);
  });

  it("a client may legitimately be in BOTH groups", () => {
    const one = [CANDIDATES[1]];
    const picks = pickShowcaseClients(one, FLOOR);
    expect(ids(picks.recentlyStarted)).toEqual([OPS]);
    expect(ids(picks.highestReturn)).toEqual([OPS]);
  });
});

describe("buildShowcaseCandidates", () => {
  const row = (over: Partial<BrandReturnRow> & { brandId: string }): BrandReturnRow => ({
    committedSpendUsd: 0,
    expectedPipelineUsd: null,
    ...over,
  });

  it("a client on TWO channels is ONE client: money sums, and its beginning is the EARLIER", () => {
    const [c] = buildShowcaseCandidates([
      [row({ brandId: DOC, committedSpendUsd: 300, expectedPipelineUsd: 900, startedOn: "2026-06-01", outcomeCount: 2 })],
      [row({ brandId: DOC, committedSpendUsd: 200, expectedPipelineUsd: 100, startedOn: "2026-02-01", outcomeCount: 5 })],
    ]);
    expect(c.committedSpendUsd).toBe(500);
    expect(c.expectedPipelineUsd).toBe(1000);
    // One client, one beginning — the earliest of the channels it runs, not whichever was read first.
    expect(c.startedOn).toBe("2026-02-01");
    expect(c.outcomeCount).toBe(7);
  });

  it("a pipeline stays NULL only when NO channel priced one, and is never coerced to 0", () => {
    const [none] = buildShowcaseCandidates([
      [row({ brandId: DOC, committedSpendUsd: 100 })],
      [row({ brandId: DOC, committedSpendUsd: 100 })],
    ]);
    expect(none.expectedPipelineUsd).toBeNull();

    const [some] = buildShowcaseCandidates([
      [row({ brandId: DOC, committedSpendUsd: 100 })],
      [row({ brandId: DOC, committedSpendUsd: 100, expectedPipelineUsd: 250 })],
    ]);
    // Only the priced channel contributes — the unpriced one is absent from the sum, not a zero in it.
    expect(some.expectedPipelineUsd).toBe(250);
  });

  it("a snapshot written before the pick fields existed narrows to nulls rather than to zeros", () => {
    const [legacy] = buildShowcaseCandidates([[row({ brandId: DOC, committedSpendUsd: 400, expectedPipelineUsd: 800 })]]);
    // Absent and explicit-null are the same statement, and neither is a 0 that would claim the client
    // began at the epoch or produced nothing.
    expect(legacy.startedOn).toBeNull();
    expect(legacy.outcomeCount).toBeNull();
    // So it ranks on return and NOT on recency — the field it lacks costs it one list, not both.
    const picks = pickShowcaseClients([legacy], FLOOR);
    expect(ids(picks.highestReturn)).toEqual([DOC]);
    expect(picks.recentlyStarted.unmeasuredReason).toBe("no_qualifying_clients");
  });

  it("a MEASURED 0 outcome count survives the fold and is not an absence", () => {
    const [c] = buildShowcaseCandidates([[row({ brandId: DOC, committedSpendUsd: 400, outcomeCount: 0 })]]);
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

describe("showcaseChainHasOutcome", () => {
  const chain = (...steps: Array<[string, number | null]>) => [
    { steps: steps.map(([key, peopleReached]) => ({ key, peopleReached })) },
  ];

  it("a chain with a contacted count and 0 on every rung has produced NOTHING", () => {
    expect(
      showcaseChainHasOutcome(
        chain(["contacted", 183], ["start_to_conversation", 0], ["conversation_to_meeting_booked", 0]),
      ),
    ).toBe(false);
  });

  it("one measured person on one rung past the base is an outcome", () => {
    expect(showcaseChainHasOutcome(chain(["contacted", 876], ["start_to_conversation", 1]))).toBe(true);
    expect(showcaseChainHasOutcome(chain(["contacted", 1146], ["start_to_website_visit", 51], ["website_visit_to_signup", 0]))).toBe(true);
  });

  it("an UNMEASURED rung never qualifies a client", () => {
    expect(showcaseChainHasOutcome(chain(["contacted", 500], ["start_to_website_visit", null]))).toBe(false);
  });

  it("no chain at all is nothing produced", () => {
    expect(showcaseChainHasOutcome([])).toBe(false);
  });

  it("any ONE of several funnels showing a rung is enough", () => {
    expect(
      showcaseChainHasOutcome([
        { steps: [{ key: "contacted", peopleReached: 10 }, { key: "start_to_conversation", peopleReached: 0 }] },
        { steps: [{ key: "contacted", peopleReached: 10 }, { key: "start_to_website_visit", peopleReached: 2 }] },
      ]),
    ).toBe(true);
  });
});
