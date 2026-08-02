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
  recipientsRepliesPositive: number;
}

/** The engagement stat keys this snapshot owns — used by the /stats handler to gate the fetch. */
export const SNAPSHOT_ENGAGEMENT_KEYS: readonly (keyof EngagementCounts)[] = [
  "recipientsContacted",
  "recipientsSent",
  "recipientsDelivered",
  "recipientsOpened",
  "recipientsClicked",
  "recipientsRepliesPositive",
];

function count(persons: EnginePerson[], signal: string): number {
  let n = 0;
  for (const p of persons) if (p.signals[signal]) n += 1;
  return n;
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

  const emails = [...new Set(persons.map((p) => p.email).filter((e): e is string => Boolean(e)))];
  const timestamps = await fetchEventTimestamps(brandId, singleCampaignId(campaignScope), emails, headers).catch((err) => {
    console.warn(
      `[features-service] engagement-snapshot open-overlay failed (degrading opened to 0, mirrors /revenue): ${(err as Error).message}`,
    );
    return null;
  });

  if (timestamps) {
    for (const person of persons) {
      const dates = person.email ? timestamps.get(person.email) : undefined;
      // A known open timestamp IS the open signal (no boolean in the leads overlay) — same as revenue.ts.
      if (dates?.open) person.signals.open = true;
    }
  }

  const deduped = dedupPersonsByLead(persons);

  return {
    recipientsContacted: count(deduped, "contacted"),
    recipientsSent: count(deduped, "sent"),
    recipientsDelivered: count(deduped, "delivered"),
    recipientsOpened: count(deduped, "open"),
    recipientsClicked: count(deduped, "clicked"),
    recipientsRepliesPositive: count(deduped, "positiveReply"),
  };
}
