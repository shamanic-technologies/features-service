import { fetchLeadsForRevenue } from "./leads-client.js";
import { fetchEventTimestamps } from "./email-status-client.js";
import { dedupPersonsByLead, type EnginePerson } from "./revenue-engine.js";
import { singleCampaignId, type CampaignFilter } from "./campaign-scope.js";

/**
 * The recipient-engagement counts that BOTH `/features/:slug/revenue` and
 * `/features/:slug/stats` must agree on. Each is a count of DISTINCT leads (deduped by
 * `leadId`, bounced/unsubscribed leads zeroed at the leads-client overlay) that fired the
 * signal — NOT a count of email-gateway recipient rows / click events.
 *
 * `recipientsClicked` here is byte-equal to `/revenue` `clicked.total` because both count the
 * SAME deduped lead snapshot: same `fetchLeadsForRevenue` overlay, same open-timestamp overlay,
 * same `dedupPersonsByLead`. The legacy email-gateway aggregate (`recipientStats.clicked`) counts
 * one recipient row PER send, so a lead served in two campaigns (or who clicked two emails of a
 * sequence) double-counts there — the +1 drift this reconciliation removes (features-service#388).
 */
export interface EngagementCounts {
  recipientsContacted: number;
  recipientsSent: number;
  recipientsDelivered: number;
  recipientsOpened: number;
  recipientsClicked: number;
  recipientsBounced: number;
  recipientsRepliesPositive: number;
  recipientsRepliesNegative: number;
  recipientsRepliesNeutral: number;
}

/** The engagement stat keys this snapshot owns — used by the /stats handler to gate the fetch. */
export const SNAPSHOT_ENGAGEMENT_KEYS: readonly (keyof EngagementCounts)[] = [
  "recipientsContacted",
  "recipientsSent",
  "recipientsDelivered",
  "recipientsOpened",
  "recipientsClicked",
  "recipientsBounced",
  "recipientsRepliesPositive",
  "recipientsRepliesNegative",
  "recipientsRepliesNeutral",
];

/**
 * The one person-grain recipient stat this snapshot CANNOT own: lead-service classifies a reply
 * `positive | negative | neutral` and has no auto-reply class, so there is no per-lead evidence to
 * count. It stays on the email-gateway aggregate — which is a distinct count at the grain it was
 * ASKED for, so summing several campaigns' aggregates counts a person once per campaign. A
 * multi-member identity therefore reports it as "could not count", never a sum.
 */
export const UNOWNED_ENGAGEMENT_KEY = "recipientsRepliesAutoReply" as const;

function count(persons: EnginePerson[], signal: string): number {
  let n = 0;
  for (const p of persons) if (p.signals[signal]) n += 1;
  return n;
}

/** Every count is a DISTINCT lead — the persons handed in must already be deduped by `leadId`. */
function countsOf(deduped: EnginePerson[]): EngagementCounts {
  return {
    recipientsContacted: count(deduped, "contacted"),
    recipientsSent: count(deduped, "sent"),
    recipientsDelivered: count(deduped, "delivered"),
    recipientsOpened: count(deduped, "open"),
    recipientsClicked: count(deduped, "clicked"),
    recipientsBounced: count(deduped, "bounced"),
    recipientsRepliesPositive: count(deduped, "positiveReply"),
    recipientsRepliesNegative: count(deduped, "negativeReply"),
    recipientsRepliesNeutral: count(deduped, "neutralReply"),
  };
}

/** An identity every one of whose member campaigns reached nobody — zero, not "unknown". */
export const ZERO_ENGAGEMENT_COUNTS: EngagementCounts = Object.freeze(countsOf([]));

/**
 * Set the `open` signal in place from email-gateway's per-email timestamps. A known open timestamp
 * IS the open signal (the leads overlay carries no boolean the engine reads) — same as revenue.ts.
 * BEST-EFFORT, same as `/revenue`: an email-gateway failure degrades `opened` to 0 on every surface
 * identically rather than failing a read whose other eight counts are sound.
 */
async function applyOpenOverlay(
  persons: EnginePerson[],
  brandId: string,
  campaignScope: CampaignFilter,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<void> {
  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const timestamps = await fetchEventTimestamps(brandId, singleCampaignId(campaignScope), emails, headers).catch((err) => {
    console.warn(
      `[features-service] engagement-snapshot open-overlay failed (degrading opened to 0, mirrors /revenue): ${(err as Error).message}`,
    );
    return null;
  });
  if (!timestamps) return;

  for (const person of persons) {
    const dates = person.email ? timestamps.get(person.email) : undefined;
    if (dates?.open) person.signals.open = true;
  }
}

/**
 * Build the recipient-engagement counts from the SAME deduped lead snapshot `/revenue` uses, so
 * the two endpoints can never disagree. Mirrors `computeFeatureRevenue`'s sequence exactly:
 *
 *   1. fetchLeadsForRevenue   — per-lead overlay (contacted/sent/delivered/clicked/positiveReply);
 *                               bounced/unsubscribed leads already have all signals false.
 *   2. open-timestamp overlay — `open` has no lead-row boolean; a known email-gateway open
 *                               timestamp IS the signal (matches revenue.ts Wave B). BEST-EFFORT,
 *                               same as `/revenue`: an email-gateway failure degrades `opened` to 0
 *                               on BOTH endpoints identically (the lead fetch itself stays fail-loud).
 *   3. dedupPersonsByLead     — collapse per-campaign rows of one lead into one person (OR signals),
 *                               so a lead clicked across two sends counts ONCE.
 *   4. count each signal.
 *
 * Brand-scoped (campaignId optional) — called with the SAME (brandId, campaignId) `/revenue` uses,
 * so the counts match by construction. Fail-loud on the lead fetch (a swallowed error would
 * silently under-report); the open overlay is the only best-effort step (mirrors `/revenue`).
 */
export async function fetchEngagementSnapshotCounts(
  brandId: string,
  // One campaign, or the family sharing one identity — the SAME scope `/revenue` reads, so the two
  // surfaces stay one number. The per-email date overlay stays brand-scoped for a family (its own
  // superset), exactly as the revenue compute does.
  campaignScope: CampaignFilter,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<EngagementCounts> {
  const persons = await fetchLeadsForRevenue(brandId, campaignScope, headers);
  await applyOpenOverlay(persons, brandId, campaignScope, headers);
  return countsOf(dedupPersonsByLead(persons));
}

/**
 * The SAME counts, one entry per campaign IDENTITY, from ONE brand-wide read.
 *
 * A campaign identity is a set of campaign rows (campaign-service pools a live campaign with the
 * stopped ancestors that share its (org, brand, funnel, channel) key). Its person-grain figures
 * cannot be the members' figures ADDED: a person contacted under two members is one person, so the
 * sum reports more people than the brand contains — the brand deduped them, the sum did not. The
 * fix is not a subtraction after the fact; it is counting the identity on the SAME basis the brand
 * counts on. So the brand's lead rows are read ONCE, grouped by the identity each row's campaign
 * belongs to, and deduped WITHIN each identity.
 *
 * Two properties fall out by construction, and they are the whole point:
 *   - every identity's figure is bounded by the brand's — its distinct leads are a SUBSET of the
 *     brand's distinct leads, for every signal;
 *   - a lead re-served under two members of one identity counts ONCE for that identity.
 *
 * A row whose producer states no campaign belongs to no identity and is counted for none (it is
 * still in the brand's own total, which is read separately). Costs one brand-wide lead read + the
 * one open overlay — the same two calls the brand-grain snapshot makes, never one per identity.
 */
export async function fetchEngagementSnapshotByIdentity(
  brandId: string,
  /** The identity key a campaign id belongs to — campaign-service's own key, resolved by the caller. */
  identityKeyOf: (campaignId: string) => string,
  headers: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<Map<string, EngagementCounts>> {
  const persons = await fetchLeadsForRevenue(brandId, undefined, headers);
  await applyOpenOverlay(persons, brandId, undefined, headers);

  const byIdentity = new Map<string, EnginePerson[]>();
  for (const person of persons) {
    if (!person.campaignId) continue;
    const key = identityKeyOf(person.campaignId);
    const bucket = byIdentity.get(key);
    if (bucket) bucket.push(person);
    else byIdentity.set(key, [person]);
  }

  const counts = new Map<string, EngagementCounts>();
  for (const [key, rows] of byIdentity) counts.set(key, countsOf(dedupPersonsByLead(rows)));
  return counts;
}
