/**
 * MONITORING: WHAT THE RATING PICKS TODAY, PER ENGINE (SCRIPT-VALUE-RATING-1113-MON; pure board `lib/script-engine-board.ts`).
 *   GET /internal/research/script-engines   (api key, staff) every Engine, its scripts ranked by today's share of draws,
 *                                            each with runs, what they reached, cost per run, the Rating's score, its
 *                                            LLM / template tactics, runs per day; + each Engine's share of draws per day.
 * Built OFF the request path every 15 min (boot step skipped while the stored copy is fresh), ONE stored copy
 * (`fleet-cell-store` key `script-engines-v1`); each build also writes today's shares into `script_draw_share_days`
 * (the stored daily series the chart reads). Red only when broken: the build is older than `STALE_AFTER_MS`.
 */
import { Router, type Request, type Response } from "express";
import { and, gte, sql } from "drizzle-orm";
import { apiKeyOnly } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { scriptDrawShareDays } from "../db/schema.js";
import { claimFleetCellBuild, loadFleetCell, storeFleetCell } from "../lib/fleet-cell-store.js";
import { storedCopyIsFresh } from "../lib/boot-warms.js";
import { BOARD_DAYS, BOARD_DRAWS, dayBefore, scriptEngineBoard, type BoardEngine } from "../lib/script-engine-board.js";
import { buildScriptRating } from "./script-rating.js";
import { SCRIPT_ENGINES_CELL } from "../lib/engine-favourites.js";

const router = Router();

/** Rebuilt on this clock. */
export const SCRIPT_ENGINES_FRESH_MS = 15 * 60_000;
/** A build older than this is broken (four missed rebuilds): red on Monitoring. */
export const STALE_AFTER_MS = 60 * 60_000;
const CLAIM_MS = 10 * 60_000;

export interface ScriptEnginesCell {
  /** When runs-service built the outcome chains the board reads. */
  ledgerBuiltAt: string;
  computedAt: string;
  draws: number;
  engines: BoardEngine[];
}

let building: Promise<"built" | "skipped"> | null = null;

/** Build the board and store it (+ today's shares). Single flight per process, one process at a time (claim). */
export function warmScriptEngines(force = false): Promise<"built" | "skipped"> {
  if (building) return building;
  building = (async () => {
    try {
      const stored = await loadFleetCell(SCRIPT_ENGINES_CELL);
      if (!force && storedCopyIsFresh(stored?.computedAt, SCRIPT_ENGINES_FRESH_MS)) return "skipped";
      if (!(await claimFleetCellBuild(SCRIPT_ENGINES_CELL, CLAIM_MS))) return "skipped";
      const rating = await buildScriptRating();
      const now = Date.now();
      const today = new Date(now).toISOString().slice(0, 10);
      const engines = scriptEngineBoard({ ratings: rating.scripts, values: rating.valueMap, runnable: rating.runnable, groups: rating.groups, today, rng: Math.random });
      const cell: ScriptEnginesCell = { ledgerBuiltAt: rating.builtAt, computedAt: new Date(now).toISOString(), draws: BOARD_DRAWS, engines };
      await storeFleetCell(SCRIPT_ENGINES_CELL, JSON.stringify(cell), now);
      await storeTodayShares(today, engines);
      return "built";
    } finally {
      building = null;
    }
  })();
  return building;
}

/** Today's share of draws of every runnable script, the latest build of the day kept. */
async function storeTodayShares(day: string, engines: readonly BoardEngine[]): Promise<void> {
  const rows = engines.flatMap((e) =>
    e.scripts.filter((s) => s.shareOfDrawsPct !== null).map((s) => ({ day, scriptDynasty: s.scriptDynasty, outcome: e.outcome, sharePct: s.shareOfDrawsPct!, runs: s.runs, computedAt: new Date() })),
  );
  if (!rows.length) return;
  await db
    .insert(scriptDrawShareDays)
    .values(rows)
    .onConflictDoUpdate({
      target: [scriptDrawShareDays.day, scriptDrawShareDays.scriptDynasty],
      set: { outcome: sql`excluded.outcome`, sharePct: sql`excluded.share_pct`, runs: sql`excluded.runs`, computedAt: sql`excluded.computed_at` },
    });
}

export function startScriptEnginesLoop(): void {
  setInterval(() => void warmScriptEngines().catch((err) => console.error("[features-service] script engines board tick failed:", err)), SCRIPT_ENGINES_FRESH_MS).unref();
}

/** PURE: the stored daily shares, one series per Engine: per day, every script's share (0 when it drew nothing that day). */
export function drawShareHistory(rows: ReadonlyArray<{ day: string; outcome: string; scriptDynasty: string; sharePct: number }>): Map<string, Array<{ day: string; shares: Array<{ scriptDynasty: string; sharePct: number }> }>> {
  const byEngine = new Map<string, Map<string, Array<{ scriptDynasty: string; sharePct: number }>>>();
  for (const r of rows) {
    const days = byEngine.get(r.outcome) ?? new Map();
    days.set(r.day, [...(days.get(r.day) ?? []), { scriptDynasty: r.scriptDynasty, sharePct: r.sharePct }]);
    byEngine.set(r.outcome, days);
  }
  return new Map(
    [...byEngine.entries()].map(([outcome, days]) => [
      outcome,
      [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, shares]) => ({ day, shares: shares.sort((a, b) => b.sharePct - a.sharePct || a.scriptDynasty.localeCompare(b.scriptDynasty)) })),
    ]),
  );
}

router.get("/internal/research/script-engines", apiKeyOnly, async (req: Request, res: Response) => {
  const outcome = typeof req.query.outcome === "string" && req.query.outcome.trim() ? req.query.outcome.trim() : null;
  try {
    const stored = await loadFleetCell(SCRIPT_ENGINES_CELL);
    if (!stored) {
      void warmScriptEngines().catch((err) => console.error("[features-service] script engines board build failed:", err));
      res.status(503).json({ error: "The board is being built (every 15 minutes).", reason: "script_engines_not_built_yet" });
      return;
    }
    const cell = JSON.parse(stored.text) as ScriptEnginesCell;
    if (!storedCopyIsFresh(stored.computedAt, SCRIPT_ENGINES_FRESH_MS)) void warmScriptEngines().catch((err) => console.error("[features-service] script engines board build failed:", err));
    const ageMs = Date.now() - stored.computedAt;
    const since = dayBefore(new Date().toISOString().slice(0, 10), BOARD_DAYS - 1);
    const rows = await db
      .select({ day: scriptDrawShareDays.day, outcome: scriptDrawShareDays.outcome, scriptDynasty: scriptDrawShareDays.scriptDynasty, sharePct: scriptDrawShareDays.sharePct })
      .from(scriptDrawShareDays)
      .where(outcome ? and(gte(scriptDrawShareDays.day, since), sql`${scriptDrawShareDays.outcome} = ${outcome}`) : gte(scriptDrawShareDays.day, since));
    const history = drawShareHistory(rows);
    const engines = cell.engines.filter((e) => !outcome || e.outcome === outcome).map((e) => ({ ...e, drawShareHistory: history.get(e.outcome) ?? [] }));
    res.json({
      ledgerBuiltAt: cell.ledgerBuiltAt,
      computedAt: cell.computedAt,
      draws: cell.draws,
      health: ageMs > STALE_AFTER_MS ? { broken: true, reason: "board_not_rebuilt" } : { broken: false, reason: null },
      engines,
    });
  } catch (error) {
    console.error("[features-service] script engines board:", error);
    res.status(502).json({ error: (error as Error).message, reason: "script_engines_unreadable" });
  }
});

export default router;
