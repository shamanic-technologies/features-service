/**
 * The store of what a campaign's brief asks for, per Engine x opt-in script tactic (`campaign_brief_opt_in_asks`,
 * migration 0084; rules in `brief-opt-in.ts`, PURE). DB only: the suite default (`src/vitest.setup.ts`) is an empty store.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignBriefOptInAsks } from "../db/schema.js";
import type { StoredBriefAsk } from "./brief-opt-in.js";

const rowOf = (r: typeof campaignBriefOptInAsks.$inferSelect): StoredBriefAsk => ({
  campaignId: r.campaignId,
  outcome: r.outcome,
  tacticId: r.tacticId,
  orgId: r.orgId,
  asks: r.asks,
  probability: r.probability,
  model: r.model,
  briefHash: r.briefHash,
  judgedDescription: r.judgedDescription,
  judgedAt: r.judgedAt.toISOString(),
});

/** The stored answers of one campaign on one Engine. */
export async function readBriefAsks(campaignId: string, outcome: string): Promise<StoredBriefAsk[]> {
  const rows = await db
    .select()
    .from(campaignBriefOptInAsks)
    .where(and(eq(campaignBriefOptInAsks.campaignId, campaignId), eq(campaignBriefOptInAsks.outcome, outcome)));
  return rows.map(rowOf);
}

/** Every stored answer of one campaign (null = of every campaign), by campaign, Engine, tactic. Never asks Jev. */
export async function listBriefAsks(campaignId: string | null): Promise<StoredBriefAsk[]> {
  const q = db.select().from(campaignBriefOptInAsks);
  const rows = campaignId
    ? await q.where(eq(campaignBriefOptInAsks.campaignId, campaignId)).orderBy(asc(campaignBriefOptInAsks.outcome), asc(campaignBriefOptInAsks.tacticId))
    : await q.orderBy(asc(campaignBriefOptInAsks.campaignId), asc(campaignBriefOptInAsks.outcome), asc(campaignBriefOptInAsks.tacticId));
  return rows.map(rowOf);
}

export async function writeBriefAsks(rows: readonly Omit<StoredBriefAsk, "judgedAt">[]): Promise<void> {
  for (const row of rows) {
    const values = { ...row, judgedAt: new Date() };
    await db
      .insert(campaignBriefOptInAsks)
      .values(values)
      .onConflictDoUpdate({ target: [campaignBriefOptInAsks.campaignId, campaignBriefOptInAsks.outcome, campaignBriefOptInAsks.tacticId], set: values });
  }
}
