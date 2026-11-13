/**
 * A CLIENT SAYS A UNIT IS NOT GOOD (SCRIPT-VALUE-RATING-1113, owner 2026-11-13).
 *   POST /orgs/unit-reports   (api key + identity) one report of one Unit: an edit of what we wrote, or a "Report".
 * One door for every surface (dashboard, API, MCP, Sophie); the store is `lib/unit-client-reports-store.ts`.
 */
import { Router, type Request, type Response } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { recordUnitReport, UNIT_REPORT_KINDS, type UnitReportKind } from "../lib/unit-client-reports-store.js";

const router = Router();
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

router.post("/orgs/unit-reports", apiKeyAuth, async (req: Request, res: Response) => {
  const { orgId, userId } = req as AuthenticatedRequest;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const outcomeKey = text(b.outcomeKey);
  const subjectService = text(b.subjectService);
  const subjectId = text(b.subjectId);
  const source = text(b.source);
  const kind = UNIT_REPORT_KINDS.find((k) => k === b.kind) as UnitReportKind | undefined;
  const noteOk = b.note === undefined || b.note === null || typeof b.note === "string";
  if (!outcomeKey || !subjectService || !subjectId || !source || !kind || !noteOk) {
    res.status(400).json({ error: `outcomeKey, subjectService, subjectId, source and kind (${UNIT_REPORT_KINDS.join(" | ")}) are required; note is text`, reason: "unit_report_unrecognised" });
    return;
  }
  try {
    res.status(201).json(await recordUnitReport({ orgId, userId, outcomeKey, subjectService, subjectId, kind, source, note: text(b.note) }));
  } catch (error) {
    console.error(`[features-service] unit report ${outcomeKey} ${subjectService}/${subjectId} not stored:`, (error as Error).message);
    res.status(502).json({ error: (error as Error).message, reason: "unit_report_unwritable" });
  }
});

export default router;
