/**
 * WAVE 2 OF THE OUTBOUND LEG RENAME, THE STORED HALF (LOCKED owner 2026-10-09; the rename itself lives in
 * `lib/funnel-legs.ts`): every row this service stores for an OUTBOUND channel moves from the legacy
 * `start_to_conversation` / `start_to_website_visit` to `lead_found_to_*`. Non-outbound rows never move.
 *
 * Three tables hold a leg key, and every row of them is covered, historical ones included:
 *  - `workflow_leg_assignments` (unique on channel × leg × dynasty): a dynasty holding BOTH spellings
 *    on one channel keeps the most recent decision (`decided_at`); the other row is deleted and counted.
 *  - `workflow_leg_assignment_changes` (append-only history, no uniqueness): every row re-keyed in place.
 *  - `sales_path_combination_names` (combination keys `leg@slug+...` and campaign keys
 *    `campaign:<slug>|<leg>`): re-keyed in place, so Victory, Sol, Herald... stay attached to the
 *    combination they name. A key whose new spelling is already named keeps the OLDER name (the one
 *    customers saw first); the newer row is deleted and counted.
 *
 * IDEMPOTENT and run at EVERY boot, after the migrations and before the port binds (three tables bounded
 * by the catalogue, a few hundred rows; once moved, each boot is three empty reads): a row a process of
 * the previous build wrote during the deploy window is moved by the next boot. Same advisory lock as the
 * name assignment, so no name is minted while a key moves.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { salesPathCombinationNames, workflowLegAssignmentChanges, workflowLegAssignments } from "../db/schema.js";
import { OUTBOUND_CHANNEL_SLUGS } from "./channel-types.js";
import { LEGACY_OUTBOUND_LEG_KEYS, servedLegKeyOf, servedNameKeyOf } from "./funnel-legs.js";
import { NAME_ASSIGNMENT_LOCK } from "./sales-path-names.js";

export interface OutboundLegKeyMigrationResult {
  assignmentsRekeyed: number;
  assignmentCollisionsDropped: number;
  assignmentChangesRekeyed: number;
  namesRekeyed: number;
  nameCollisionsDropped: number;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const OUTBOUND = [...OUTBOUND_CHANNEL_SLUGS];

/** One assignment row as the planner sees it. */
export interface AssignmentRowLike {
  featureSlug: string;
  legKey: string;
  workflowDynastySlug: string;
  decidedAt: Date;
}

/** What to do with the assignment rows: DELETE these (a collision's loser), then RE-KEY these. */
export interface AssignmentPlan {
  deletes: Array<{ featureSlug: string; legKey: string; workflowDynastySlug: string }>;
  rekeys: Array<{ featureSlug: string; workflowDynastySlug: string; from: string; to: string }>;
}

/** PURE: every legacy outbound row moves to its new spelling; a dynasty holding BOTH spellings on one
 *  channel keeps the most recent decision (a tie keeps the new-spelled row). */
export function planAssignments(rows: readonly AssignmentRowLike[]): AssignmentPlan {
  const plan: AssignmentPlan = { deletes: [], rekeys: [] };
  const byIdentity = new Map(rows.map((r) => [`${r.featureSlug}|${r.legKey}|${r.workflowDynastySlug}`, r]));
  for (const row of rows) {
    const to = servedLegKeyOf(row.featureSlug, row.legKey);
    if (to === row.legKey) continue;
    const twin = byIdentity.get(`${row.featureSlug}|${to}|${row.workflowDynastySlug}`);
    if (twin && twin.decidedAt >= row.decidedAt) {
      plan.deletes.push({ featureSlug: row.featureSlug, legKey: row.legKey, workflowDynastySlug: row.workflowDynastySlug });
      continue;
    }
    if (twin) plan.deletes.push({ featureSlug: twin.featureSlug, legKey: twin.legKey, workflowDynastySlug: twin.workflowDynastySlug });
    plan.rekeys.push({ featureSlug: row.featureSlug, workflowDynastySlug: row.workflowDynastySlug, from: row.legKey, to });
  }
  return plan;
}

/** One name row as the planner sees it. */
export interface NameRowLike {
  combinationKey: string;
  name: string;
  assignedAt: Date;
}

/** What to do with the name rows: DELETE these keys (a collision's loser), then RE-KEY these. */
export interface NamePlan {
  deletes: string[];
  rekeys: Array<{ from: string; to: string; name: string }>;
}

/** PURE: every key naming an outbound leg in its legacy spelling moves to the served one, its NAME with it;
 *  a key whose new spelling is already named keeps the OLDER name (a tie keeps the new-spelled row). */
export function planNames(rows: readonly NameRowLike[]): NamePlan {
  const plan: NamePlan = { deletes: [], rekeys: [] };
  const byKey = new Map(rows.map((r) => [r.combinationKey, r]));
  for (const row of rows) {
    const to = servedNameKeyOf(row.combinationKey);
    if (to === row.combinationKey) continue;
    const twin = byKey.get(to);
    if (twin && twin.assignedAt <= row.assignedAt) {
      plan.deletes.push(row.combinationKey);
      continue;
    }
    if (twin) plan.deletes.push(twin.combinationKey);
    plan.rekeys.push({ from: row.combinationKey, to, name: row.name });
  }
  return plan;
}

async function migrateAssignments(tx: Tx, result: OutboundLegKeyMigrationResult): Promise<void> {
  const rows = await tx.select().from(workflowLegAssignments).where(inArray(workflowLegAssignments.featureSlug, OUTBOUND));
  const plan = planAssignments(rows);
  const identity = (featureSlug: string, legKey: string, workflowDynastySlug: string) =>
    and(
      eq(workflowLegAssignments.featureSlug, featureSlug),
      eq(workflowLegAssignments.legKey, legKey),
      eq(workflowLegAssignments.workflowDynastySlug, workflowDynastySlug),
    );
  for (const d of plan.deletes) await tx.delete(workflowLegAssignments).where(identity(d.featureSlug, d.legKey, d.workflowDynastySlug));
  for (const r of plan.rekeys) {
    await tx.update(workflowLegAssignments).set({ legKey: r.to }).where(identity(r.featureSlug, r.from, r.workflowDynastySlug));
  }
  result.assignmentCollisionsDropped = plan.deletes.length;
  result.assignmentsRekeyed = plan.rekeys.length;
  const moved = await tx
    .update(workflowLegAssignmentChanges)
    .set({ legKey: sql`'lead_found_to_' || substr(${workflowLegAssignmentChanges.legKey}, ${"start_to_".length + 1})` })
    .where(
      and(inArray(workflowLegAssignmentChanges.featureSlug, OUTBOUND), inArray(workflowLegAssignmentChanges.legKey, [...LEGACY_OUTBOUND_LEG_KEYS])),
    )
    .returning({ id: workflowLegAssignmentChanges.id });
  result.assignmentChangesRekeyed = moved.length;
}

async function migrateNames(tx: Tx, result: OutboundLegKeyMigrationResult): Promise<void> {
  const plan = planNames(await tx.select().from(salesPathCombinationNames));
  for (const key of plan.deletes) {
    await tx.delete(salesPathCombinationNames).where(eq(salesPathCombinationNames.combinationKey, key));
    console.log(`[features-service] outbound leg keys: name row ${key} dropped (its new spelling keeps the older name)`);
  }
  for (const r of plan.rekeys) {
    await tx.update(salesPathCombinationNames).set({ combinationKey: r.to }).where(eq(salesPathCombinationNames.combinationKey, r.from));
  }
  result.nameCollisionsDropped = plan.deletes.length;
  result.namesRekeyed = plan.rekeys.length;
}

/** Move every stored outbound leg key to its new spelling. Fail-loud: a DB error throws (boot stops). */
export async function migrateOutboundLegKeys(): Promise<OutboundLegKeyMigrationResult> {
  const result: OutboundLegKeyMigrationResult = {
    assignmentsRekeyed: 0,
    assignmentCollisionsDropped: 0,
    assignmentChangesRekeyed: 0,
    namesRekeyed: 0,
    nameCollisionsDropped: 0,
  };
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${NAME_ASSIGNMENT_LOCK})`);
    await migrateAssignments(tx, result);
    await migrateNames(tx, result);
  });
  console.log(`[features-service] outbound leg keys (wave 2): ${JSON.stringify(result)}`);
  return result;
}
