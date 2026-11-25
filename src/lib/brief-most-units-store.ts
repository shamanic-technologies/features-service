/**
 * The store of the most Units a campaign's brief allows per Engine (`campaign_brief_most_units`, migration 0085; rules in
 * `brief-most-units.ts`, PURE). DB only: the suite default (`src/vitest.setup.ts`) is an empty store.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignBriefMostUnits } from "../db/schema.js";
import type { Period, StoredBriefMostUnits } from "./brief-most-units.js";

const rowOf = (r: typeof campaignBriefMostUnits.$inferSelect): StoredBriefMostUnits => ({
  campaignId: r.campaignId,
  outcome: r.outcome,
  orgId: r.orgId,
  units: r.units,
  per: r.per as Period | null,
  probability: r.probability,
  confidence: r.confidence,
  model: r.model,
  briefHash: r.briefHash,
  rule: r.rule,
  judgedAt: r.judgedAt.toISOString(),
});

/** The stored answer of one campaign on one Engine; null = never judged. */
export async function readBriefMostUnits(campaignId: string, outcome: string): Promise<StoredBriefMostUnits | null> {
  const [r] = await db
    .select()
    .from(campaignBriefMostUnits)
    .where(and(eq(campaignBriefMostUnits.campaignId, campaignId), eq(campaignBriefMostUnits.outcome, outcome)));
  return r ? rowOf(r) : null;
}

/** Every stored answer of one campaign, by Engine. Never asks Jev. */
export async function listBriefMostUnits(campaignId: string): Promise<StoredBriefMostUnits[]> {
  const rows = await db.select().from(campaignBriefMostUnits).where(eq(campaignBriefMostUnits.campaignId, campaignId)).orderBy(asc(campaignBriefMostUnits.outcome));
  return rows.map(rowOf);
}

export async function writeBriefMostUnits(row: Omit<StoredBriefMostUnits, "judgedAt">): Promise<void> {
  const values = { ...row, judgedAt: new Date() };
  await db
    .insert(campaignBriefMostUnits)
    .values(values)
    .onConflictDoUpdate({ target: [campaignBriefMostUnits.campaignId, campaignBriefMostUnits.outcome], set: values });
}
