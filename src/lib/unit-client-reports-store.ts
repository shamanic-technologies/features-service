/**
 * A CLIENT SAYS A UNIT IS NOT GOOD (SCRIPT-VALUE-RATING-1113, owner 2026-11-13; migration 0072).
 * « Chaque fois qu'un user fait un edit, on peut considérer que l'outcome était unsatisfying » ; an outcome the client
 * cannot edit (a sent message) gets a "Report". No positive vote: silence says nothing, what the Unit led to decides.
 * The Unit is named as the ledger names it (outcome, subject service, subject id): no outcome is named in code.
 * Append-only; the write fails loud (a report we lost would read as silence).
 */
import { db } from "../db/index.js";
import { unitClientReports } from "../db/schema.js";

export const UNIT_REPORT_KINDS = ["edited", "reported"] as const;
export type UnitReportKind = (typeof UNIT_REPORT_KINDS)[number];

export interface UnitReportInput {
  orgId: string;
  userId: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  kind: UnitReportKind;
  /** Where it was said (the dashboard, the API, the MCP, Sophie): free text, stated by the caller. */
  source: string;
  note: string | null;
}

export interface UnitReport extends UnitReportInput {
  id: string;
  reportedAt: string;
}

export async function recordUnitReport(input: UnitReportInput): Promise<UnitReport> {
  const [row] = await db.insert(unitClientReports).values(input).returning();
  return { ...input, id: row!.id, reportedAt: row!.reportedAt.toISOString() };
}
