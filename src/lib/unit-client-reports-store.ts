/**
 * A CLIENT SAYS A UNIT IS NOT GOOD (SCRIPT-VALUE-RATING-1113, owner 2026-11-13; migration 0072).
 * « Chaque fois qu'un user fait un edit, on peut considérer que l'outcome était unsatisfying » ; an outcome the client
 * cannot edit (a sent message) gets a "Report". No positive vote: silence says nothing, what the Unit led to decides.
 * The Unit is named as the ledger names it (outcome, subject service, subject id): no outcome is named in code.
 * Append-only; the write fails loud (a report we lost would read as silence).
 */
import { and, desc, eq } from "drizzle-orm";
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
  /**
   * When the thing the client points at was made (ISO), e.g. a message's send time: one subject holds several Units over
   * time (a lead holds every message written for them) and the ledger resolves the Unit standing THEN. Null = the Unit
   * standing when the report was made.
   */
  unitAt: string | null;
}

export interface UnitReport extends UnitReportInput {
  id: string;
  reportedAt: string;
}

export async function recordUnitReport(input: UnitReportInput): Promise<UnitReport> {
  const [row] = await db
    .insert(unitClientReports)
    .values({ ...input, unitAt: input.unitAt === null ? null : new Date(input.unitAt) })
    .returning();
  return { ...input, id: row!.id, reportedAt: row!.reportedAt.toISOString() };
}

/** Every reported Unit, as the ledger names it, with when it was reported. Fails loud. */
export async function listUnitReports(): Promise<Array<Pick<UnitReport, "outcomeKey" | "subjectService" | "subjectId" | "reportedAt" | "unitAt">>> {
  const rows = await db
    .select({ outcomeKey: unitClientReports.outcomeKey, subjectService: unitClientReports.subjectService, subjectId: unitClientReports.subjectId, reportedAt: unitClientReports.reportedAt, unitAt: unitClientReports.unitAt })
    .from(unitClientReports);
  return rows.map((r) => ({ outcomeKey: r.outcomeKey, subjectService: r.subjectService, subjectId: r.subjectId, reportedAt: r.reportedAt.toISOString(), unitAt: r.unitAt?.toISOString() ?? null }));
}

/** One org's own reports of one subject (every outcome, or one), newest first: what a page shows as "reported". Fails loud. */
export async function listOrgUnitReports(q: { orgId: string; subjectService: string; subjectId: string; outcomeKey: string | null }): Promise<UnitReport[]> {
  const rows = await db
    .select()
    .from(unitClientReports)
    .where(
      and(
        eq(unitClientReports.orgId, q.orgId),
        eq(unitClientReports.subjectService, q.subjectService),
        eq(unitClientReports.subjectId, q.subjectId),
        ...(q.outcomeKey === null ? [] : [eq(unitClientReports.outcomeKey, q.outcomeKey)]),
      ),
    )
    .orderBy(desc(unitClientReports.reportedAt));
  return rows.map((r) => ({
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    outcomeKey: r.outcomeKey,
    subjectService: r.subjectService,
    subjectId: r.subjectId,
    kind: r.kind as UnitReportKind,
    source: r.source,
    note: r.note,
    unitAt: r.unitAt?.toISOString() ?? null,
    reportedAt: r.reportedAt.toISOString(),
  }));
}
