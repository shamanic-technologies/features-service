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
 * ── ONE GROUP ─────────────────────────────────────────────────────────────────────────────────
 *
 *   - **recentlyStarted** — the hero card row, which proves BOOKED MEETINGS (owner 2026-10-19,
 *     SHOWCASE-MEETINGS-1019: « mettre les last 3 brand qui ont eu au moins des booked meetings? Si
 *     moins de 3, tu peux prendre ceux qui ont eu des Interested leads? ... et plus jamais des "website
 *     visits" »; supersedes, for this group, the 2026-10-10 floor of 5 people on one rung). The 3 most
 *     recently begun clients with at least 1 meeting booked, newest first; then, if fewer than 3, the
 *     most recently begun clients with at least 1 positive reply. A website visit never qualifies a
 *     client here. Active or not (owner 2026-10-10). Decided on each walked client's own person
 *     counts (`pickRecentlyStartedByMeetings`); the snapshot only prefilters on any rung reached.
 *
 *     **AN OUTCOME IS A RUNG THE FUNNEL CONVERTS TO — never the outreach base.** Being contacted is
 *     the base every funnel converts FROM, so a client whose only measured count is how many people
 *     we emailed has produced nothing, and the card row must not name it. Nor is a signal a rung
 *     merely because this service counts it: a website visit is not a step of a funnel that starts on
 *     a positive reply, so a client that sells the reply funnel and collected a few clicks has still
 *     produced nothing on the chain the homepage draws for it. Measured in prod 2026-09-24: Living
 *     Vital (livingvital.ch) sat in the row with 183 contacted and 0 at every rung past it, admitted
 *     by a gate that summed clicks and positive replies whatever funnel the client sells. So the gate
 *     reads the rungs themselves: the snapshot stores the furthest RUNG count the warm walked
 *     (`furthestRungReached`), and the route then decides on each walked client's own meetings booked
 *     and positive replies. An UNMEASURED rung (`null`) never qualifies anybody: we cannot claim what
 *     we did not count.
 *   The `highestReturn` group (best return past a spend floor) is deleted (ROI-CONSISTENCY-1103: a
 *   return exists only where a value lands, never a pipeline-based ratio on our homepage).
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
 * Every ingredient is read off `fleet_return_snapshots` — the per-brand rows a background warm writes
 * (the table keeps its historical name). So the pick costs ONE indexed SELECT plus arithmetic, and the
 * minutes-long engine fan-out that produced those rows happened off the request path days ago. The
 * consumer is a statically-rendered marketing page that gives this read eight seconds and drops the
 * section rather than block a build; a pick that re-derived a per-brand return would blow that budget
 * on its first cold call.
 */
import type { BrandSnapshotRow } from "./fleet-return-store.js";
import type { FunnelStepBreakdown } from "./funnel-steps.js";

/** How many clients the group names: the homepage shows three. */
export const SHOWCASE_GROUP_SIZE = 3;

/**
 * The fewest people on a rung for the snapshot to put a client forward for `recentlyStarted`: any.
 * The group is decided after the walk on meetings booked, then positive replies, at least 1 each
 * (owner 2026-10-19, SHOWCASE-MEETINGS-1019), so the prefilter only drops clients with nothing at all.
 */
export const SHOWCASE_RECENT_MIN_RUNG_PEOPLE = 1;

/**
 * Staff, mirrored from api-service `STAFF_EMAILS` (billing-service keeps the same copy), plus any
 * `@distribute.you` address. Plus-addressing is ignored, so `kevin.lourd+e2e@gmail.com` is staff.
 */
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you"]);
const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  if (normalized.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = normalized.split("@");
  return STAFF_EMAILS.has(`${local.split("+")[0]}@${domain}`);
}

/**
 * PURE: a STAFF TEST org = every member is staff (billing-service's `staff_test_org`, the same rule).
 * The homepage never names a client whose every claiming org is one (owner 2026-10-19: Reed, a brand
 * of "STAFF TEST - Email Sending E2E", stood on the hero). An org with no member is not called staff, and a
 * member with no email on record is a person nobody can call staff (GrowthAgency.dev: 6 of 7 members).
 */
export function isStaffOnlyOrg(memberEmails: readonly string[] | null): boolean {
  return memberEmails !== null && memberEmails.length > 0 && memberEmails.every(isStaffEmail);
}

/** One walked recent candidate's two hero counts. Null = could not count (never qualifies). */
export interface RecentShowcaseCounts {
  brandId: string;
  meetingsBooked: number | null;
  positiveReplies: number | null;
}

/**
 * PURE: the `recentlyStarted` group over walked candidates given NEWEST FIRST. Clients with at least 1
 * meeting booked lead, in that order; the remaining slots go to clients with at least 1 positive reply
 * and no meeting, in that order. A client with neither (website visits only, or nothing counted) is
 * rejected. `complete` is true once `requestedCount` meeting clients are found: no older client can
 * displace them, so the walk may stop.
 */
export function pickRecentlyStartedByMeetings(
  walkedNewestFirst: readonly RecentShowcaseCounts[],
  requestedCount: number = SHOWCASE_GROUP_SIZE,
): { brandIds: string[]; meetingClients: number; replyClients: number; rejected: number; complete: boolean } {
  const meetings: string[] = [];
  const replies: string[] = [];
  let rejected = 0;
  for (const c of walkedNewestFirst) {
    if (c.meetingsBooked !== null && c.meetingsBooked >= 1) meetings.push(c.brandId);
    else if (c.positiveReplies !== null && c.positiveReplies >= 1) replies.push(c.brandId);
    else rejected += 1;
  }
  return {
    brandIds: [...meetings, ...replies].slice(0, requestedCount),
    meetingClients: meetings.length,
    replyClients: replies.length,
    rejected,
    complete: meetings.length >= requestedCount,
  };
}

/** Why a group named nobody. Both are real answers; neither is an error. */
export type ShowcaseGroupUnmeasuredReason =
  /** No warm has written a snapshot for any channel yet, so there is nothing to rank at all. */
  | "no_snapshot_yet"
  /** A snapshot exists and no client passes this group's gate — too new, too cheap, or nothing shown. */
  | "no_qualifying_clients";

/** One brand's aggregated ingredients across every channel it runs — the row a pick ranks. */
export interface ShowcaseCandidate {
  brandId: string;
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

/** The pick. */
export interface ShowcaseClientPicks {
  /** Most recently begun clients that have produced at least one outcome, newest first. */
  recentlyStarted: ShowcaseGroupPick;
}

/**
 * PURE: fold one channel's stored rows into the per-brand candidates, across every channel.
 *
 * A brand that runs two channels is ONE client to the homepage: its beginning is the earliest of the
 * two and its rung counts sum (an upper bound, read only as a prefilter).
 */
export function buildShowcaseCandidates(rowsByChannel: ReadonlyArray<readonly BrandSnapshotRow[]>): ShowcaseCandidate[] {
  const byBrand = new Map<string, ShowcaseCandidate & { hasOutcome: boolean }>();
  for (const rows of rowsByChannel) {
    for (const row of rows) {
      const agg = byBrand.get(row.brandId) ?? { brandId: row.brandId, startedOn: null, outcomeCount: null, hasOutcome: false };
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
  return [...byBrand.values()].map(({ hasOutcome: _o, ...c }) => c);
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

/** PURE: the snapshot prefilter — a rung count that COULD clear the minimum. */
function mayShowOutcome(c: ShowcaseCandidate, minPeople: number): boolean {
  return c.outcomeCount !== null && c.outcomeCount >= minPeople;
}

/**
 * PURE: the pick over the candidates.
 *
 * `candidates === null` means no snapshot exists at all — the one silence that is NOT "nobody
 * qualifies", and the two are kept apart because a reader acts differently on each.
 *
 * The order is TOTAL: the beginning first, then the brand id, so the same evidence always names the
 * same clients in the same order and a tie can never make the list wobble between reads.
 */
export function pickShowcaseClients(
  candidates: readonly ShowcaseCandidate[] | null,
  requestedCount: number = SHOWCASE_GROUP_SIZE,
  recentMinRungPeople: number = SHOWCASE_RECENT_MIN_RUNG_PEOPLE,
): ShowcaseClientPicks {
  if (candidates === null) return { recentlyStarted: emptyGroup("no_snapshot_yet", requestedCount) };

  // RECENCY — a client we can date, whose funnel has moved at least one person onto a RUNG past the
  // outreach base (a measured 0 or an unmeasured null fails). This is only the PREFILTER, newest
  // first: the route walks the candidates and names meetings-booked clients first, then positive-reply
  // clients (`pickRecentlyStartedByMeetings`), never one with website visits alone.
  const recent = candidates
    .filter((c) => c.startedOn !== null && mayShowOutcome(c, recentMinRungPeople))
    .sort((a, b) =>
      a.startedOn === b.startedOn
        ? a.brandId.localeCompare(b.brandId)
        : (b.startedOn as string).localeCompare(a.startedOn as string),
    );
  return { recentlyStarted: groupOf(recent, requestedCount) };
}
