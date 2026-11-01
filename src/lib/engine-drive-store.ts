/**
 * Persistence of the Engine's live drives (`lib/engine-drive.ts`, table `engine_drives`, migration 0059). Written by the
 * stored factory pass, read per unit campaign by the leg-keyed workflow-projection (one primary-key read).
 */
import { eq, notInArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { engineDrives } from "../db/schema.js";
import type { DriveGuard } from "./engine-drive.js";

export interface EngineDriveRow {
  unitCampaignId: string;
  funnelCampaignId: string;
  orgId: string;
  brandId: string;
  outcome: string;
  pipeId: string;
  workflowDynastySlug: string;
  serviceDynastySlug: string | null;
  state: "driving" | "rolled_back";
  switchedAt: string;
  rolledBackAt: string | null;
  guard: (DriveGuard & { outcomeName: string; source: string }) | null;
  updatedAt: string;
}

const rowOf = (r: typeof engineDrives.$inferSelect): EngineDriveRow => ({
  unitCampaignId: r.unitCampaignId,
  funnelCampaignId: r.funnelCampaignId,
  orgId: r.orgId,
  brandId: r.brandId,
  outcome: r.outcome,
  pipeId: r.pipeId,
  workflowDynastySlug: r.workflowDynastySlug,
  serviceDynastySlug: r.serviceDynastySlug,
  state: r.state as EngineDriveRow["state"],
  switchedAt: r.switchedAt.toISOString(),
  rolledBackAt: r.rolledBackAt ? r.rolledBackAt.toISOString() : null,
  guard: (r.guard ?? null) as EngineDriveRow["guard"],
  updatedAt: r.updatedAt.toISOString(),
});

export async function readDrives(): Promise<EngineDriveRow[]> {
  return (await db.select().from(engineDrives)).map(rowOf);
}

export async function readDrive(unitCampaignId: string): Promise<EngineDriveRow | null> {
  const [r] = await db.select().from(engineDrives).where(eq(engineDrives.unitCampaignId, unitCampaignId)).limit(1);
  return r ? rowOf(r) : null;
}

export async function writeDrive(row: Omit<EngineDriveRow, "updatedAt">): Promise<void> {
  const values = {
    ...row,
    switchedAt: new Date(row.switchedAt),
    rolledBackAt: row.rolledBackAt ? new Date(row.rolledBackAt) : null,
    updatedAt: new Date(),
  };
  await db.insert(engineDrives).values(values).onConflictDoUpdate({ target: engineDrives.unitCampaignId, set: values });
}

/** Every drive whose unit is no longer handed to the Engine is removed (the service path again). */
export async function keepOnlyDrives(unitCampaignIds: readonly string[]): Promise<void> {
  if (unitCampaignIds.length === 0) await db.delete(engineDrives);
  else await db.delete(engineDrives).where(notInArray(engineDrives.unitCampaignId, [...unitCampaignIds]));
}
