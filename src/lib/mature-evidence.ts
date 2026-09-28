/**
 * THE MATURE COHORT'S COUNTS, per workflow slug and per (audience × workflow dynasty) — the person half of
 * every mature figure (`lib/maturity.ts`): the leads SERVED before the cutoff (run-start clock), counted
 * once per person, whenever their outcomes landed.
 *
 * Why persons and not the sender's aggregates: email-gateway states no date filter at all (its day groups
 * bucket an event by the day it HAPPENED, never by the day the lead was served), so the only way to count
 * "the outcomes of the leads those runs served" is on lead-service's population, which states each lead's
 * serve date (`lastServedAt`), the campaign and workflow it was served under, and the audience the serve
 * drew it from. The counts are emitted in email-gateway's stats shape (`recipientsContacted` /
 * `recipientsClicked` / `recipientsRepliesPositive`) so the grain rollups read them unchanged.
 */
import type { EnginePerson } from "./revenue-engine.js";
import { servedInMatureCohort } from "./maturity.js";

/** The three counted signals a grain observes, for one group of persons. */
export interface PersonCounts {
  contacted: number;
  clicks: number;
  replies: number;
}

/**
 * TRUE when EVERY row states its serve date (lead-service stamps every compact row with `lastServedAt`,
 * null for a row never served) — vacuously true for an empty population. FALSE as soon as ONE row lacks
 * the field: a producer predating it, or a live lead copy (lib/lead-copy.ts) holding rows snapshotted
 * before the producer served it and not yet re-sent by the change feed. Such a population cannot be cut —
 * a row read as "no serve date, so in the cohort" would count young leads as mature with no error.
 */
export function serveDatesStated(persons: readonly EnginePerson[]): boolean {
  return persons.every((p) => p.servedAt !== undefined);
}

function countInto(counts: PersonCounts, p: EnginePerson): void {
  if (p.signals.contacted) counts.contacted += 1;
  if (p.signals.clicked) counts.clicks += 1;
  if (p.signals.positiveReply) counts.replies += 1;
}

/**
 * PURE. Per workflow slug: the deduped persons served before `cutoffIso` (restricted to `campaignIds` when
 * given) — how many were contacted, clicked, replied positively. A person with no workflow belongs to no
 * slug, exactly like an untagged send. `cutoffIso` null keeps every person (a 0-day leg: mature ≡ flash).
 */
export function matureSlugStats(
  persons: readonly EnginePerson[],
  cutoffIso: string | null,
  campaignIds?: ReadonlySet<string> | null,
): Map<string, Record<string, number>> {
  const bySlug = new Map<string, PersonCounts>();
  for (const p of persons) {
    if (!p.workflowSlug) continue;
    if (campaignIds && (!p.campaignId || !campaignIds.has(p.campaignId))) continue;
    if (!servedInMatureCohort(p.servedAt, cutoffIso)) continue;
    const counts = bySlug.get(p.workflowSlug) ?? { contacted: 0, clicks: 0, replies: 0 };
    countInto(counts, p);
    bySlug.set(p.workflowSlug, counts);
  }
  return new Map(
    [...bySlug].map(([slug, c]) => [
      slug,
      { recipientsContacted: c.contacted, recipientsClicked: c.clicks, recipientsRepliesPositive: c.replies },
    ]),
  );
}

/**
 * PURE. Per (audience × workflow dynasty): the deduped persons served before `cutoffIso`, attributed to the
 * audience their SERVE drew them from (the tag lead-service froze at serve time — never a membership
 * resolution), restricted to `audienceIds` and, on a leg, to `campaignIds`. A person whose serve carried no
 * audience belongs to no audience, exactly like an untagged send.
 */
export function matureAudienceDynastyCounts(
  persons: readonly EnginePerson[],
  cutoffIso: string | null,
  audienceIds: ReadonlySet<string>,
  slugToDynasty: ReadonlyMap<string, string>,
  campaignIds?: ReadonlySet<string> | null,
): Map<string, Map<string, PersonCounts>> {
  const out = new Map<string, Map<string, PersonCounts>>();
  for (const p of persons) {
    if (!p.audienceId || !audienceIds.has(p.audienceId) || !p.workflowSlug) continue;
    if (campaignIds && (!p.campaignId || !campaignIds.has(p.campaignId))) continue;
    if (!servedInMatureCohort(p.servedAt, cutoffIso)) continue;
    const dynasty = slugToDynasty.get(p.workflowSlug) ?? p.workflowSlug;
    const byDynasty = out.get(p.audienceId) ?? new Map<string, PersonCounts>();
    const counts = byDynasty.get(dynasty) ?? { contacted: 0, clicks: 0, replies: 0 };
    countInto(counts, p);
    byDynasty.set(dynasty, counts);
    out.set(p.audienceId, byDynasty);
  }
  return out;
}
