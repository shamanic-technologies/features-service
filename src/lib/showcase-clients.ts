/**
 * WHICH CLIENTS OUR OWN HOMEPAGE NAMES — picked here, ordered here, from measured evidence.
 *
 * The apex page names real clients in a row of live cards ("who else grows on autopilot"). This module
 * decides WHICH clients, from what this service has measured; the page renders the pick and ranks
 * nothing.
 *
 * ── THE PICKS ARE THE SERVICE'S DECISION, NEVER THE CALLER'S ────────────────────────────────────
 *
 * There is deliberately NO request parameter naming a brand anywhere on this surface. This is an
 * unauthenticated read of NAMED clients' funnel figures; a caller-supplied identifier would turn it
 * into a way to read any brand's funnel with no session at all.
 *
 * ── ONE GROUP: THE BIGGEST FIGURES WE HAVE (owner 2026-11-07, SHOWCASE-MAX-1107) ─────────────────
 *
 *   - **recentlyStarted** (wire key kept so the landing reads it unchanged) — the hero card row: the 3
 *     clients with the MOST meetings booked, ties and fill broken by the most positive replies
 *     (interested leads), over the whole history, whenever they began, active or not. Owner, verbatim:
 *     « JAMAIS 1 SEUL!!!! ENVOIE DU REVE!! METS LE MAX QU'ON A ». Replaces the 2026-10-19 rule (the 3
 *     most recently begun clients), which served obra.cam alone with 1 interested lead on 2026-11-07.
 *     A client qualifies with at least 1 meeting booked or 1 positive reply; a website visit never
 *     qualifies anybody. The row is always 3 when 3 clients have ever produced one.
 *
 *     The counts are the SAME counts the client reads on its own dashboard: every conversion. The
 *     "outreach-caused only" filter of 2026-10-29 is removed (owner 2026-11-07: « enlève ce putain de
 *     filtre »).
 *
 * ── THE EVIDENCE IS THE PERSISTED FLEET SNAPSHOT, WHICH IS WHY THIS IS FAST ─────────────────────
 *
 * Every ingredient is read off `fleet_return_snapshots` — the per-brand rows a background warm writes
 * (historical table name): each brand's meetings booked and positive replies. So the pick costs ONE
 * indexed SELECT plus a sort, and the route then walks only the head of that order to draw each card
 * (`pickByMostMeetings` re-orders on the walked counts, the figures the cards print). A brand whose
 * snapshot counts are unknown (a row written before the counts existed) is walked only after every
 * brand with known counts.
 *
 * ── A GROUP WITH NOTHING TO SAY SAYS SO ─────────────────────────────────────────────────────────
 *
 * An empty group is never a shrug: `measured` is false and `unmeasuredReason` names which of the two
 * silences it is — no snapshot has been written yet, or a snapshot exists and nobody qualifies.
 * `qualifyingCount` says how many clients passed the gate.
 */
import type { BrandSnapshotRow } from "./fleet-return-store.js";
import type { FunnelStepBreakdown } from "./funnel-steps.js";

/** How many clients the group names: the homepage shows three. */
export const SHOWCASE_GROUP_SIZE = 3;

/**
 * Staff, mirrored from api-service `STAFF_EMAILS` (billing-service keeps the same copy), plus any
 * `@distribute.you` address, plus `kevin@pressbeat.io`, the owner's TEST user (counts as us, its org is
 * excluded from customer figures; client-service's `owner-telegram.ts` carries the same entry). Plus-addressing
 * is ignored, so `kevin.lourd+e2e@gmail.com` is staff.
 */
const STAFF_EMAILS = new Set(["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"]);
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

/**
 * PURE: is a BRAND ours (never named on the homepage)? Its claiming orgs' member lists: an org with no member
 * (or unknown to client-service, `null`) ABSTAINS, since nobody stands behind it (a torn-down test org); the
 * brand is ours when at least one org has members and every such org is a staff test org. Prod 2026-11-07:
 * PressBeat, claimed by `kevin@pressbeat.io`'s org plus three member-less orgs, would have stood second on
 * the hero.
 */
export function isStaffOnlyBrand(orgMemberLists: ReadonlyArray<readonly string[] | null>): boolean {
  const voting = orgMemberLists.filter((m): m is readonly string[] => m !== null && m.length > 0);
  return voting.length > 0 && voting.every((m) => isStaffOnlyOrg(m));
}

/** One walked candidate's two hero counts. Null = could not count (never qualifies on that count). */
export interface RecentShowcaseCounts {
  brandId: string;
  meetingsBooked: number | null;
  positiveReplies: number | null;
}

/** PURE: does a client have something to show on the hero card (≥1 meeting booked or ≥1 positive reply)? */
export function hasHeroOutcome(c: { meetingsBooked: number | null; positiveReplies: number | null }): boolean {
  return (c.meetingsBooked ?? 0) >= 1 || (c.positiveReplies ?? 0) >= 1;
}

/**
 * PURE: the hero order — most meetings booked first, then most positive replies, then the brand id so the
 * same evidence always names the same clients in the same order. A null count sorts as 0.
 */
export function compareByMostMeetings(a: RecentShowcaseCounts, b: RecentShowcaseCounts): number {
  const meetings = (b.meetingsBooked ?? 0) - (a.meetingsBooked ?? 0);
  if (meetings !== 0) return meetings;
  const replies = (b.positiveReplies ?? 0) - (a.positiveReplies ?? 0);
  if (replies !== 0) return replies;
  return a.brandId.localeCompare(b.brandId);
}

/**
 * PURE: the `recentlyStarted` group over walked candidates (owner 2026-11-07, SHOWCASE-MAX-1107): the
 * clients with at least 1 meeting booked or 1 positive reply, MOST meetings first, ties and fill broken
 * by most positive replies; the first `requestedCount`. A client with neither (website visits only, or
 * nothing counted) is rejected.
 */
export function pickByMostMeetings(
  walked: readonly RecentShowcaseCounts[],
  requestedCount: number = SHOWCASE_GROUP_SIZE,
): { brandIds: string[]; ranked: RecentShowcaseCounts[]; qualifying: number; rejected: number } {
  const ranked = walked.filter(hasHeroOutcome).sort(compareByMostMeetings);
  return {
    brandIds: ranked.slice(0, requestedCount).map((c) => c.brandId),
    ranked,
    qualifying: ranked.length,
    rejected: walked.length - ranked.length,
  };
}

/** Why a group named nobody. Both are real answers; neither is an error. */
export type ShowcaseGroupUnmeasuredReason =
  /** No warm has written a snapshot for any channel yet, so there is nothing to rank at all. */
  | "no_snapshot_yet"
  /** A snapshot exists and no client has a meeting booked or a positive reply. */
  | "no_qualifying_clients";

/** One brand's aggregated ingredients across every channel it runs — the row a pick ranks. */
export interface ShowcaseCandidate {
  brandId: string;
  /**
   * People on the furthest RUNG the brand's funnel reached (summed across channels). Read only to order
   * candidates whose hero counts are unknown; never served. Null when no rung could be counted.
   */
  outcomeCount: number | null;
  /** Meetings booked, every conversion, summed across channels. Null = unknown (never counted). */
  meetingsBooked: number | null;
  /** Positive replies, every conversion, summed across channels. Null = unknown (never counted). */
  positiveReplies: number | null;
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
   * EVERY candidate worth walking, in walk order — `brandIds` is its head. Internal: the route walks down
   * it until the row is filled from the biggest figures. Never served.
   */
  rankedBrandIds: string[];
  /** How many clients passed the gate BEFORE the cut to `requestedCount`. */
  qualifyingCount: number;
}

/** The pick. */
export interface ShowcaseClientPicks {
  /** The clients with the most meetings booked, then most positive replies (SHOWCASE-MAX-1107). */
  recentlyStarted: ShowcaseGroupPick;
}

/** PURE: a + b where null means "never counted" (null + null stays null). */
function addKnown(a: number | null, b: number | null | undefined): number | null {
  const v = b ?? null;
  if (v === null) return a;
  return (a ?? 0) + v;
}

/**
 * PURE: fold every channel's stored rows into the per-brand candidates. A brand that runs two channels is
 * ONE client to the homepage: its counts sum (an upper bound, read only to order the walk).
 */
export function buildShowcaseCandidates(rowsByChannel: ReadonlyArray<readonly BrandSnapshotRow[]>): ShowcaseCandidate[] {
  const byBrand = new Map<string, ShowcaseCandidate>();
  for (const rows of rowsByChannel) {
    for (const row of rows) {
      const agg = byBrand.get(row.brandId) ?? { brandId: row.brandId, outcomeCount: null, meetingsBooked: null, positiveReplies: null };
      agg.outcomeCount = addKnown(agg.outcomeCount, row.outcomeCount);
      agg.meetingsBooked = addKnown(agg.meetingsBooked, row.meetingsBooked);
      agg.positiveReplies = addKnown(agg.positiveReplies, row.positiveReplies);
      byBrand.set(row.brandId, agg);
    }
  }
  return [...byBrand.values()];
}

/** An empty group, carrying the reason it is empty. */
function emptyGroup(reason: ShowcaseGroupUnmeasuredReason, requestedCount: number): ShowcaseGroupPick {
  return { brandIds: [], measured: false, unmeasuredReason: reason, requestedCount, rankedBrandIds: [], qualifyingCount: 0 };
}

/**
 * PURE: the furthest RUNG one walked funnel reached — the largest measured `recipientsReached` among
 * its steps (the outreach base is not a rung). Null when nothing was walked or every rung was unmeasured.
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

/** PURE: are this candidate's hero counts unknown (a snapshot row written before they were stored)? */
function countsUnknown(c: ShowcaseCandidate): boolean {
  return c.meetingsBooked === null && c.positiveReplies === null;
}

/**
 * PURE: the pick over the candidates (owner 2026-11-07, SHOWCASE-MAX-1107).
 *
 * `candidates === null` means no snapshot exists at all — the one silence that is NOT "nobody qualifies".
 *
 * Walk order: every candidate with ≥1 meeting booked or ≥1 positive reply, most meetings first, then most
 * positive replies, then brand id (TOTAL, so a tie never wobbles between reads); then every candidate whose
 * counts are UNKNOWN and whose furthest rung is not a measured 0, biggest rung first. A candidate counted at
 * 0 meetings and 0 positive replies is never walked. No start date, no recency: the biggest figures win.
 */
export function pickShowcaseClients(
  candidates: readonly ShowcaseCandidate[] | null,
  requestedCount: number = SHOWCASE_GROUP_SIZE,
): ShowcaseClientPicks {
  if (candidates === null) return { recentlyStarted: emptyGroup("no_snapshot_yet", requestedCount) };
  const known = candidates.filter((c) => !countsUnknown(c) && hasHeroOutcome(c)).sort(compareByMostMeetings);
  const unknown = candidates
    .filter((c) => countsUnknown(c) && c.outcomeCount !== 0)
    .sort((a, b) => {
      const d = (b.outcomeCount ?? -1) - (a.outcomeCount ?? -1);
      return d !== 0 ? d : a.brandId.localeCompare(b.brandId);
    });
  const ordered = [...known, ...unknown];
  if (ordered.length === 0) return { recentlyStarted: emptyGroup("no_qualifying_clients", requestedCount) };
  return {
    recentlyStarted: {
      brandIds: ordered.slice(0, requestedCount).map((c) => c.brandId),
      measured: true,
      unmeasuredReason: null,
      requestedCount,
      rankedBrandIds: ordered.map((c) => c.brandId),
      qualifyingCount: ordered.length,
    },
  };
}

/**
 * PURE: may the route stop walking? Once `requestedCount` walked clients qualify, it stops unless the next
 * unwalked candidate's SNAPSHOT counts beat the current last pick's walked counts (it could then displace it).
 * A next candidate with unknown counts never forces another walk once the row is full.
 */
export function walkComplete(
  verdict: { ranked: readonly RecentShowcaseCounts[] },
  next: ShowcaseCandidate | undefined,
  requestedCount: number = SHOWCASE_GROUP_SIZE,
): boolean {
  if (verdict.ranked.length < requestedCount) return false;
  if (next === undefined || countsUnknown(next)) return true;
  const last = verdict.ranked[requestedCount - 1];
  // `next` sorts BEFORE the last pick ⟺ it could displace it.
  return compareByMostMeetings({ ...next, brandId: last.brandId }, last) >= 0;
}
