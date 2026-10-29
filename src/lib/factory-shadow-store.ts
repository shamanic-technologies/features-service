/**
 * Persistence of the GTM Factory shadow (`lib/factory-shadow.ts`): the brief judge's verdicts, the last plan per funnel
 * campaign, the daily Monitoring rows. Derived and rebuildable: the next pass rewrites them.
 */
import { desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { factoryBriefJudgments, factoryBriefPrefills, factoryPipeVerdicts, factoryShadowDaily, factoryShadowPlans } from "../db/schema.js";
import type { BriefJudgment, OrgDayCounts, PipeVerdict, ShadowStatus } from "./factory-shadow.js";

/** Every stored verdict of these campaigns, keyed `<campaignId>|<basePipeId>`. */
export async function readJudgments(campaignIds: readonly string[]): Promise<Map<string, BriefJudgment>> {
  const out = new Map<string, BriefJudgment>();
  if (campaignIds.length === 0) return out;
  const rows = await db.select().from(factoryBriefJudgments).where(inArray(factoryBriefJudgments.campaignId, [...campaignIds]));
  for (const r of rows) {
    out.set(`${r.campaignId}|${r.basePipeId}`, {
      campaignId: r.campaignId,
      basePipeId: r.basePipeId,
      briefHash: r.briefHash,
      playsSignature: r.playsSignature,
      chosenPipeId: r.chosenPipeId,
      defaultPipeId: r.defaultPipeId,
      confidence: r.confidence,
      probabilities: r.probabilities ?? null,
      model: r.model,
      source: r.source as BriefJudgment["source"],
      judgedAt: r.judgedAt.toISOString(),
    });
  }
  return out;
}

/** Upsert one verdict (a re-judge replaces the previous one in place). */
export async function writeJudgment(j: BriefJudgment & { orgId: string; briefUpdatedAt: string | null }): Promise<void> {
  const values = {
    campaignId: j.campaignId,
    basePipeId: j.basePipeId,
    orgId: j.orgId,
    briefHash: j.briefHash,
    briefUpdatedAt: j.briefUpdatedAt ? new Date(j.briefUpdatedAt) : null,
    playsSignature: j.playsSignature,
    chosenPipeId: j.chosenPipeId,
    defaultPipeId: j.defaultPipeId,
    confidence: j.confidence,
    probabilities: j.probabilities,
    model: j.model,
    source: j.source,
    judgedAt: new Date(j.judgedAt),
  };
  await db
    .insert(factoryBriefJudgments)
    .values(values)
    .onConflictDoUpdate({ target: [factoryBriefJudgments.campaignId, factoryBriefJudgments.basePipeId], set: { ...values } });
}

export async function writePlan(row: { campaignId: string; orgId: string; brandId: string; offerId: string; status: ShadowStatus; failure: string | null; body: unknown; computedAt: Date }): Promise<void> {
  await db
    .insert(factoryShadowPlans)
    .values(row)
    .onConflictDoUpdate({ target: factoryShadowPlans.campaignId, set: { orgId: row.orgId, brandId: row.brandId, offerId: row.offerId, status: row.status, failure: row.failure, body: row.body, computedAt: row.computedAt } });
}

export async function readPlan(campaignId: string): Promise<{ orgId: string; brandId: string; offerId: string; status: string; failure: string | null; body: unknown; computedAt: string } | null> {
  const [r] = await db.select().from(factoryShadowPlans).where(eq(factoryShadowPlans.campaignId, campaignId)).limit(1);
  return r ? { orgId: r.orgId, brandId: r.brandId, offerId: r.offerId, status: r.status, failure: r.failure, body: r.body, computedAt: r.computedAt.toISOString() } : null;
}

/** The plans of the campaigns of the last pass (the Monitoring drill-down), newest first. */
export async function readPlansSince(since: Date): Promise<Array<{ campaignId: string; orgId: string; brandId: string; status: string; failure: string | null; body: unknown; computedAt: string }>> {
  const rows = await db.select().from(factoryShadowPlans).where(gte(factoryShadowPlans.computedAt, since)).orderBy(desc(factoryShadowPlans.computedAt));
  return rows.map((r) => ({ campaignId: r.campaignId, orgId: r.orgId, brandId: r.brandId, status: r.status, failure: r.failure, body: r.body, computedAt: r.computedAt.toISOString() }));
}

/** Rewrite TODAY's rows of the daily series with this pass's counts (an org absent from the pass is removed for today). */
export async function writeDay(day: string, counts: readonly OrgDayCounts[], sweptAt: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(factoryShadowDaily).where(eq(factoryShadowDaily.day, day));
    if (counts.length > 0) await tx.insert(factoryShadowDaily).values(counts.map((c) => ({ day, ...c, sweptAt })));
  });
}

export async function readDays(sinceDay: string): Promise<Array<OrgDayCounts & { day: string; sweptAt: string }>> {
  const rows = await db.select().from(factoryShadowDaily).where(gte(factoryShadowDaily.day, sinceDay)).orderBy(factoryShadowDaily.day, factoryShadowDaily.orgId);
  return rows.map((r) => ({
    day: r.day,
    orgId: r.orgId,
    campaigns: r.campaigns,
    planDiffers: r.planDiffers,
    pickDiffers: r.pickDiffers,
    differs: r.differs,
    judgeFailed: r.judgeFailed,
    planFailed: r.planFailed,
    sweptAt: r.sweptAt.toISOString(),
  }));
}

/** The brief this service last prefilled on each campaign (a campaign whose brief still equals it was never edited). */
export async function readPrefills(): Promise<Map<string, string>> {
  const rows = await db.select({ id: factoryBriefPrefills.campaignId, brief: factoryBriefPrefills.brief }).from(factoryBriefPrefills);
  return new Map(rows.map((r) => [r.id, r.brief]));
}

/** Record (or, on a rewrite of our own unedited brief, replace) the brief prefilled on a campaign. */
export async function recordPrefill(row: { campaignId: string; orgId: string; brief: string }): Promise<void> {
  await db
    .insert(factoryBriefPrefills)
    .values(row)
    .onConflictDoUpdate({ target: factoryBriefPrefills.campaignId, set: { brief: row.brief, writtenAt: new Date() } });
}

/** Every stored pipe verdict of these campaigns, keyed `<campaignId>|<pipeId>`. */
export async function readPipeVerdicts(campaignIds: readonly string[]): Promise<Map<string, PipeVerdict>> {
  const out = new Map<string, PipeVerdict>();
  if (campaignIds.length === 0) return out;
  const rows = await db.select().from(factoryPipeVerdicts).where(inArray(factoryPipeVerdicts.campaignId, [...campaignIds]));
  for (const r of rows) out.set(`${r.campaignId}|${r.pipeId}`, { campaignId: r.campaignId, pipeId: r.pipeId, briefHash: r.briefHash, pipeSignature: r.pipeSignature, excluded: r.excluded, probability: r.probability, model: r.model, judgedAt: r.judgedAt.toISOString() });
  return out;
}

export async function writePipeVerdict(v: PipeVerdict & { orgId: string }): Promise<void> {
  const values = { ...v, judgedAt: new Date(v.judgedAt) };
  await db.insert(factoryPipeVerdicts).values(values).onConflictDoUpdate({ target: [factoryPipeVerdicts.campaignId, factoryPipeVerdicts.pipeId], set: values });
}
