/**
 * WHICH CLIENTS OUR OWN HOMEPAGE NAMES — picked here, ordered here, from measured evidence.
 *
 * The apex page names real clients in two places: a row of live cards ("who else grows on autopilot")
 * and a proof section under it ("what our clients got back"). Until now the clients in both were a
 * frozen list of three brand ids in this service's code, pasted into the page's HTML as well — so the
 * page named whoever somebody had decided to name in September, forever, and adding a client meant a
 * human editing a constant. This module replaces that constant with two PICKS the service makes from
 * what it has measured.
 *
 * ── THE PICKS ARE THE SERVICE'S DECISION, NEVER THE CALLER'S ────────────────────────────────────
 *
 * There is still deliberately NO request parameter naming a brand anywhere on this surface. This is an
 * unauthenticated read of NAMED clients' funnel figures; a caller-supplied identifier would turn it
 * into a way to read any brand's funnel with no session at all. What changed is only WHO decides the
 * list: an allowlist a human curated, or a ranking this service computes. Both keep the caller out.
 *
 * ── TWO GROUPS, TWO QUESTIONS, AND A CLIENT MAY BE IN BOTH ──────────────────────────────────────
 *
 *   - **recentlyStarted** — the most recently begun clients that have produced at least one outcome.
 *     The card row's question is "who else is on this right now", so a client that started last week
 *     and has something to show beats one that started a year ago and has more.
 *
 *     **AN OUTCOME IS A RUNG THE FUNNEL CONVERTS TO — never the outreach base.** Being contacted is
 *     the base every funnel converts FROM, so a client whose only measured count is how many people
 *     we emailed has produced nothing, and the card row must not name it. Nor is a signal a rung
 *     merely because this service counts it: a website visit is not a step of a funnel that starts on
 *     a positive reply, so a client that sells the reply funnel and collected a few clicks has still
 *     produced nothing on the chain the homepage draws for it. Measured in prod 2026-09-24: Living
 *     Vital (livingvital.ch) sat in the row with 183 contacted and 0 at every rung past it, admitted
 *     by a gate that summed clicks and positive replies whatever funnel the client sells. So the gate
 *     reads the rungs themselves — twice: the snapshot stores the furthest RUNG count the warm walked
 *     (`furthestRungReached`), and the route then walks each pick's own chain and keeps it only when
 *     that chain shows a measured, positive count past the base (`showcaseChainHasOutcome`). An
 *     UNMEASURED rung (`null`) never qualifies anybody: we cannot claim what we did not count.
 *   - **highestReturn** — the clients whose money came back best, past a floor of spend. The proof
 *     section's question is "what does this return", so it leads with the best measured answers.
 *
 * A client that both began recently and returns best is legitimately in both groups; nothing is
 * deduped between them, because a group is an ANSWER to its own question rather than a slice of one
 * list.
 *
 * ── WHEN A CLIENT BEGAN IS THE FIRST DAY THEY WERE BILLED ───────────────────────────────────────
 *
 * This service holds no signup date and should not invent one. What it does hold — through
 * runs-service's dated cost ledger — is the FIRST UTC DAY a brand was ever billed for the channel,
 * which is the day their paid outreach began. That is a measured fact rather than a declaration, it
 * is the same notion `agency-self-serve-compute.ts` already uses for "since this pair began", and a
 * brand with no such day is simply not a candidate (never dated with a stand-in, which would reorder
 * the one ranking it decides).
 *
 * ── THE RETURN RANKING RESTS ON A SPEND FLOOR, AND THE FLOOR IS STATED ──────────────────────────
 *
 * A ratio over a denominator too small to mean anything is not a return, it is whatever the first
 * reply happened to do. Measured in production 2026-09-22 on the cold-email channel, the top of an
 * UNFILTERED ranking is a brand at **21.5x on $4.12 of spend** and another at **12.3x on $9.77** —
 * both ahead of clients with hundreds of dollars behind their number. The same $100 floor
 * `fleet-return-on-spend.ts` applies to the published median applies here, and the group STATES it,
 * because a ranking whose population a reader cannot see is a ranking they cannot check.
 *
 * ── A GROUP WITH NOTHING TO SAY SAYS SO ─────────────────────────────────────────────────────────
 *
 * An empty group is never a shrug: `measured` is false and `unmeasuredReason` names which of the two
 * silences it is — no snapshot has been written yet (nothing to rank), or a snapshot exists and
 * nobody qualifies (something to say, and a different thing). A SHORT group is not silent either:
 * `qualifyingCount` says how many clients passed the gate, so `qualifyingCount < requestedCount` is
 * visible on the wire rather than inferred from a list's length.
 *
 * ── THE EVIDENCE IS THE PERSISTED FLEET SNAPSHOT, WHICH IS WHY THIS IS FAST ─────────────────────
 *
 * Every ingredient is read off `fleet_return_snapshots` — the per-brand rows a background warm already
 * writes for the published median. So the pick costs ONE indexed SELECT plus arithmetic, and the
 * minutes-long engine fan-out that produced those rows happened off the request path days ago. The
 * consumer is a statically-rendered marketing page that gives this read eight seconds and drops the
 * section rather than block a build; a pick that re-derived a per-brand return would blow that budget
 * on its first cold call.
 */
import type { BrandReturnRow } from "./fleet-return-on-spend.js";
import type { FunnelStepBreakdown } from "./funnel-steps.js";

/** How many clients each group names. Both groups of the homepage show three. */
export const SHOWCASE_GROUP_SIZE = 3;

/** Why a group named nobody. Both are real answers; neither is an error. */
export type ShowcaseGroupUnmeasuredReason =
  /** No warm has written a snapshot for any channel yet, so there is nothing to rank at all. */
  | "no_snapshot_yet"
  /** A snapshot exists and no client passes this group's gate — too new, too cheap, or nothing shown. */
  | "no_qualifying_clients";

/** One brand's aggregated ingredients across every channel it runs — the row a pick ranks. */
export interface ShowcaseCandidate {
  brandId: string;
  /** Committed spend, summed across the channels this brand runs. */
  committedSpendUsd: number;
  /** Expected pipeline, summed across the channels that priced one. Null when NONE of them did. */
  expectedPipelineUsd: number | null;
  /** The EARLIEST first-billed day across the brand's channels — one client, one beginning. */
  startedOn: string | null;
  /**
   * How many people reached the furthest-reached RUNG of the funnel(s) this brand's warm walked —
   * a rung the funnel converts TO, never the outreach base (see `furthestRungReached`). Summed across
   * channels, so it is an upper bound; that is harmless and deliberate — it is read ONLY as a `> 0`
   * prefilter and is never served. Null when no rung could be counted.
   */
  outcomeCount: number | null;
}

/** One picked group: the brand ids in the order the page states them, plus what the pick rests on. */
export interface ShowcaseGroupPick {
  /** The brand ids, already ordered. Empty exactly when `measured` is false. */
  brandIds: string[];
  /** True iff at least one client was named. False always carries a reason. */
  measured: boolean;
  unmeasuredReason: ShowcaseGroupUnmeasuredReason | null;
  /** How many clients this group set out to name. */
  requestedCount: number;
  /**
   * EVERY client that passed the gate, in the group's order — `brandIds` is its head. Internal: the
   * route walks down it when a named client's own chain turns out to show nothing past the base, so
   * the row is filled from the next honest candidate rather than padded. Never served.
   */
  rankedBrandIds: string[];
  /**
   * How many clients passed the gate BEFORE the cut to `requestedCount`. A short group is therefore
   * visible as a fact on the wire (`qualifyingCount < requestedCount`) rather than as a list somebody
   * has to count.
   */
  qualifyingCount: number;
}

/** The two picks. */
export interface ShowcaseClientPicks {
  /** Most recently begun clients that have produced at least one outcome, newest first. */
  recentlyStarted: ShowcaseGroupPick;
  /** Best measured return on spend, past the floor, best first. */
  highestReturn: ShowcaseGroupPick;
  /** The spend floor `highestReturn` was taken over, in USD. Echoed so a reader can check it. */
  minSpendUsd: number;
}

/**
 * PURE: fold one channel's stored rows into the per-brand candidates, across every channel.
 *
 * A brand that runs two channels is ONE client to the homepage, so its spend and pipeline sum (the
 * rows are already per-brand-per-channel and a cost row belongs to exactly one channel, so nothing is
 * double-counted) and its beginning is the earliest of the two. A pipeline stays null only when NO
 * channel priced one — null is never coerced to 0, which would say the outreach returns nothing.
 */
export function buildShowcaseCandidates(
  rowsByChannel: ReadonlyArray<readonly BrandReturnRow[]>,
): ShowcaseCandidate[] {
  const byBrand = new Map<string, ShowcaseCandidate & { hasPipeline: boolean; hasOutcome: boolean }>();
  for (const rows of rowsByChannel) {
    for (const row of rows) {
      const agg =
        byBrand.get(row.brandId) ??
        {
          brandId: row.brandId,
          committedSpendUsd: 0,
          expectedPipelineUsd: null,
          startedOn: null,
          outcomeCount: null,
          hasPipeline: false,
          hasOutcome: false,
        };
      agg.committedSpendUsd += row.committedSpendUsd;
      if (row.expectedPipelineUsd !== null && row.expectedPipelineUsd !== undefined) {
        agg.expectedPipelineUsd = (agg.hasPipeline ? (agg.expectedPipelineUsd as number) : 0) + row.expectedPipelineUsd;
        agg.hasPipeline = true;
      }
      const started = row.startedOn ?? null;
      // ISO `YYYY-MM-DD` sorts lexically, so the earliest is a string comparison — no parsing, and no
      // timezone to get wrong.
      if (started !== null && (agg.startedOn === null || started < agg.startedOn)) agg.startedOn = started;
      const outcomes = row.outcomeCount ?? null;
      if (outcomes !== null) {
        agg.outcomeCount = (agg.hasOutcome ? (agg.outcomeCount as number) : 0) + outcomes;
        agg.hasOutcome = true;
      }
      byBrand.set(row.brandId, agg);
    }
  }
  return [...byBrand.values()].map(({ hasPipeline: _p, hasOutcome: _o, ...c }) => c);
}

/** An empty group, carrying the reason it is empty. */
function emptyGroup(
  reason: ShowcaseGroupUnmeasuredReason,
  requestedCount: number,
): ShowcaseGroupPick {
  return {
    brandIds: [],
    measured: false,
    unmeasuredReason: reason,
    requestedCount,
    rankedBrandIds: [],
    qualifyingCount: 0,
  };
}

/** A group built from an ordered, already-gated candidate list. */
function groupOf(ordered: ShowcaseCandidate[], requestedCount: number): ShowcaseGroupPick {
  if (ordered.length === 0) return emptyGroup("no_qualifying_clients", requestedCount);
  return {
    brandIds: ordered.slice(0, requestedCount).map((c) => c.brandId),
    measured: true,
    unmeasuredReason: null,
    requestedCount,
    rankedBrandIds: ordered.map((c) => c.brandId),
    qualifyingCount: ordered.length,
  };
}

/**
 * PURE: the furthest RUNG one walked funnel reached — the largest measured `recipientsReached` among
 * its steps. Every step of a `FunnelStepBreakdown` is a rung the funnel converts TO; the outreach base
 * rides beside them as `contactedRecipients` and is deliberately NOT read here, because being contacted
 * is not an outcome. Null when nothing was walked or every rung was unmeasured — never a 0 standing in
 * for "we could not count this".
 */
export function furthestRungReached(breakdown: FunnelStepBreakdown | null | undefined): number | null {
  if (!breakdown) return null;
  let max: number | null = null;
  for (const step of breakdown.steps) {
    if (step.recipientsReached === null) continue;
    if (max === null || step.recipientsReached > max) max = step.recipientsReached;
  }
  return max;
}

/** The one step of a showcase chain that is the outreach BASE rather than a rung. */
const OUTREACH_BASE_STEP_KEY = "contacted";

/**
 * PURE: does a client's walked showcase chain show anything past the outreach base? True iff SOME
 * funnel carries a step other than `contacted` with a MEASURED, POSITIVE count. A measured 0 is
 * nothing produced; a null is nothing counted; neither qualifies. This is the check the recency row is
 * finally decided on, because it reads the exact chain the homepage draws under the client's name.
 */
export function showcaseChainHasOutcome(
  funnels: ReadonlyArray<{ steps: ReadonlyArray<{ key: string; peopleReached: number | null }> }>,
): boolean {
  return funnels.some((f) =>
    f.steps.some((s) => s.key !== OUTREACH_BASE_STEP_KEY && s.peopleReached !== null && s.peopleReached > 0),
  );
}

/**
 * PURE: the two picks over the candidates.
 *
 * `candidates === null` means no snapshot exists at all — the one silence that is NOT "nobody
 * qualifies", and the two are kept apart because a reader acts differently on each.
 *
 * Both orders are TOTAL: the ranking value first, then the brand id, so the same evidence always
 * names the same clients in the same order and a tie can never make the list wobble between reads.
 */
export function pickShowcaseClients(
  candidates: readonly ShowcaseCandidate[] | null,
  minSpendUsd: number,
  requestedCount: number = SHOWCASE_GROUP_SIZE,
): ShowcaseClientPicks {
  if (candidates === null) {
    return {
      recentlyStarted: emptyGroup("no_snapshot_yet", requestedCount),
      highestReturn: emptyGroup("no_snapshot_yet", requestedCount),
      minSpendUsd,
    };
  }

  // RECENCY — a client we can date, whose funnel has moved at least one person onto a RUNG past the
  // outreach base. The outcome gate is what stops the row leading with a brand that signed up on Friday
  // and has nothing to show; a MEASURED 0 fails it, and an unmeasured null fails it too (we cannot
  // claim what we did not count). This is the PREFILTER; the route confirms each pick on its own
  // walked chain before naming it.
  const recent = candidates
    .filter((c) => c.startedOn !== null && c.outcomeCount !== null && c.outcomeCount > 0)
    .sort((a, b) =>
      a.startedOn === b.startedOn
        ? a.brandId.localeCompare(b.brandId)
        : (b.startedOn as string).localeCompare(a.startedOn as string),
    );

  // RETURN — a client past the spend floor whose pipeline is priced. A brand below the floor is not a
  // weaker answer, it is no answer: its ratio is decided by whichever single outcome happened to land.
  const byReturn = candidates
    .filter(
      (c) =>
        c.expectedPipelineUsd !== null && c.committedSpendUsd > 0 && c.committedSpendUsd >= minSpendUsd,
    )
    .map((c) => ({ c, ratio: (c.expectedPipelineUsd as number) / c.committedSpendUsd }))
    .sort((a, b) => (a.ratio === b.ratio ? a.c.brandId.localeCompare(b.c.brandId) : b.ratio - a.ratio))
    .map((r) => r.c);

  return {
    recentlyStarted: groupOf(recent, requestedCount),
    highestReturn: groupOf(byReturn, requestedCount),
    minSpendUsd,
  };
}
