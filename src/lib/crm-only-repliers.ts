/**
 * The positive repliers ONLY the customer's CRM evidences, for the surfaces that count replies from
 * email-gateway aggregates.
 *
 * A positive reply has two witnesses (features-service#1064): the reply the sender classified, and the
 * customer's own CRM form submitted after our first delivered email (lead-service's ledger, served on the
 * compact lead row as `crmPositiveReplyAt`). email-gateway's per-workflow / per-audience / per-campaign
 * counts hold every sender-classified one and none of the CRM ones, so what each of them is missing is
 * EXACTLY the set here — added on top, nobody counted twice. The per-person union is `leads-client.ts`'s
 * (`EnginePerson.crmPositiveReplyAt` is set only when no row of the lead carries a classified reply), so
 * this module holds no second definition of a positive reply.
 *
 * A person is attributed to the WORKFLOW the lead-service row it survived dedup on was served under — the
 * attribution lead-service froze at serve time, the same key `?groupBy=workflow` partitions leads on.
 * A row stating no workflow belongs to no workflow grain, exactly like an untagged send.
 */

import type { CampaignFilter } from "./campaign-scope.js";
import { fetchLeadsForRevenue } from "./leads-client.js";
import { dedupPersonsByLead } from "./revenue-engine.js";

export interface CrmOnlyReplier {
  leadId: string;
  /** Lowercased, trimmed — the key audience membership is joined on. Null when the row carries none. */
  email: string | null;
  campaignId: string | null;
  workflowSlug: string | null;
}

/**
 * The CRM-only positive repliers of a brand, or of one campaign scope (a campaign or its identity's
 * members). Fails loud: a surface that cannot read them fails the way it already fails on its other
 * inputs — never a silent return to the sender's count alone.
 */
export async function fetchCrmOnlyRepliers(
  brandId: string,
  campaignScope: CampaignFilter,
  identity: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<CrmOnlyReplier[]> {
  const persons = dedupPersonsByLead(await fetchLeadsForRevenue(brandId, campaignScope, identity));
  const out: CrmOnlyReplier[] = [];
  for (const p of persons) {
    if (!p.crmPositiveReplyAt || !p.signals.positiveReply) continue;
    out.push({
      leadId: p.leadId,
      email: p.email ? p.email.trim().toLowerCase() : null,
      campaignId: p.campaignId ?? null,
      workflowSlug: p.workflowSlug ?? null,
    });
  }
  return out;
}

/** A person the lead population states replied positively, by EITHER witness (email or CRM). */
export interface PositiveReplier extends CrmOnlyReplier {
  /** True when only the customer's CRM evidences the reply — what an email-gateway count cannot see. */
  crmOnly: boolean;
}

/**
 * EVERY positive replier of a brand or campaign scope, one entry per PERSON (deduped by lead) — the same
 * person set `/stats` recipientsRepliesPositive counts. Each person carries the ONE workflow slug and
 * campaign of the row it survived dedup on, so a count partitioned by workflow is additive and sums to
 * the scope's total (verified in prod on Doc Dinners 2026-09-25: 26 repliers, each on exactly one lead
 * row). Fails loud like `fetchCrmOnlyRepliers`.
 */
export async function fetchPositiveRepliers(
  brandId: string,
  campaignScope: CampaignFilter,
  identity: { orgId: string; userId?: string; runId?: string; featureSlug?: string },
): Promise<PositiveReplier[]> {
  const persons = dedupPersonsByLead(await fetchLeadsForRevenue(brandId, campaignScope, identity));
  const out: PositiveReplier[] = [];
  for (const p of persons) {
    if (!p.signals.positiveReply) continue;
    out.push({
      leadId: p.leadId,
      email: p.email ? p.email.trim().toLowerCase() : null,
      campaignId: p.campaignId ?? null,
      workflowSlug: p.workflowSlug ?? null,
      crmOnly: Boolean(p.crmPositiveReplyAt),
    });
  }
  return out;
}

/**
 * REPLACE email-gateway's per-slug positive-reply count with the person count, IN PLACE, before the
 * dynasty rollup reads it. email-gateway's per-slug sums can hold one replier under two slugs (Doc
 * Dinners: 24 by slug against 23 distinct), and they cannot see a CRM-evidenced reply at all; the person
 * partition has neither defect. A slug email-gateway answered for with nobody in it reads 0.
 */
export function setPersonRepliesOnSlugStats(
  statsBySlug: Map<string, Record<string, number>>,
  repliers: readonly PositiveReplier[],
): void {
  for (const stats of statsBySlug.values()) stats.recipientsRepliesPositive = 0;
  for (const [slug, count] of crmRepliesBySlug(repliers)) {
    const existing = statsBySlug.get(slug) ?? {};
    existing.recipientsRepliesPositive = count;
    statsBySlug.set(slug, existing);
  }
}

/** Count repliers per workflow slug (distinct leads) — whichever replier set it is handed. */
export function crmRepliesBySlug(repliers: readonly CrmOnlyReplier[]): Map<string, number> {
  const bySlug = new Map<string, Set<string>>();
  for (const r of repliers) {
    if (!r.workflowSlug) continue;
    const set = bySlug.get(r.workflowSlug) ?? new Set<string>();
    set.add(r.leadId);
    bySlug.set(r.workflowSlug, set);
  }
  return new Map([...bySlug].map(([slug, set]) => [slug, set.size]));
}
