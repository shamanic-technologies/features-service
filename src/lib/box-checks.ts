/**
 * BOX CHECKS (BOX-WATCHDOGS-1030). ONE generic registry for every watchdog script the production Hetzner box runs (deploy
 * pipeline, service health, workflow queue, Jev chain, own-org balance, and any future one): each run POSTS its result under
 * a CHECK NAME the caller chooses (never a route or a table per check, owner « NE CRÉE PLUS JAMAIS DES CAS PARTICULIERS »).
 * Stored one row per (check, run instant) in `box_check_runs` (a re-send of the same instant REPLACES it) and served to the
 * staff Monitoring hub with a VERDICT per check the dashboard renders as-is. No alerting from the service: red on the hub is
 * the alert (owner 2026-10-22 « no email in my inbox please »). Pure: no DB, no clock (the caller passes `now`).
 *
 * Verdict per check, from its LATEST run:
 * - `broken` when that run reported `ok: false` (its own plain-words reason is served), OR when no run arrived for more than
 *   STALE_CADENCE_MULTIPLIER x the cadence the latest run declared (a silent check is blind, and blindness is loud);
 * - `ok` otherwise;
 * - `not_yet` only for a check the reader EXPECTS (`?expect=`) that never reported: a normal "not yet", never red.
 * A check never seen and not expected is simply absent.
 */
import { z } from "zod";

export const STALE_CADENCE_MULTIPLIER = 3;
export const RECENT_HOURS = 48;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 90;
export const RETENTION_DAYS = 90;
export const MAX_RUNS_PER_BATCH = 500;
export const MAX_DETAILS_JSON_CHARS = 20_000;
export const CHECK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const BoxCheckRunSchema = z
  .object({
    check: z
      .string()
      .regex(CHECK_NAME_PATTERN)
      .describe(
        "The check's name, chosen by the caller: lowercase letters, digits and dashes, 1 to 63 chars (e.g. `deploy-pipeline`, " +
          "`service-health`, `workflow-queue`, `jev-chain`, `own-org-balance`). A new name is a new check: no server change needed.",
      ),
    ranAt: z
      .string()
      .datetime({ offset: true })
      .describe("When the run happened (ISO 8601). With `check`, the run's identity: re-sending the same instant replaces it."),
    ok: z.boolean().describe("The run's verdict: false = something is BROKEN right now (the check turns red on the hub)."),
    reason: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .describe("Plain words for a human: WHY it is broken (required when ok = false), or what it found when ok."),
    cadenceMinutes: z
      .number()
      .int()
      .min(1)
      .max(10_080)
      .describe(
        `How often the check runs, in minutes (5, 15, 60, 360...). The check reads broken when no run arrives for more than ` +
          `${STALE_CADENCE_MULTIPLIER} x this.`,
      ),
    label: z.string().trim().min(1).max(200).optional().describe("Human title of the check (e.g. `Deploy pipeline`). Latest wins."),
    value: z
      .number()
      .finite()
      .nullable()
      .optional()
      .describe("The check's main measured value for the chart (e.g. services unhealthy, jobs overdue, balance USD). Null/absent = none."),
    unit: z.string().trim().min(1).max(40).optional().describe("Unit of `value` (e.g. `services`, `jobs`, `minutes`, `usd`). Latest wins."),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(`Free JSON object with the run's specifics (failing services, HTTP status, body excerpt...). Max ${MAX_DETAILS_JSON_CHARS} chars serialized.`),
  })
  .refine((r) => r.ok || (r.reason != null && r.reason.length > 0), {
    message: "reason is required when ok is false",
    path: ["reason"],
  })
  .refine((r) => r.details == null || JSON.stringify(r.details).length <= MAX_DETAILS_JSON_CHARS, {
    message: `details must serialize to at most ${MAX_DETAILS_JSON_CHARS} chars`,
    path: ["details"],
  });

export const BoxCheckBatchSchema = z
  .object({
    runs: z.array(BoxCheckRunSchema).min(1).max(MAX_RUNS_PER_BATCH).describe(`1 to ${MAX_RUNS_PER_BATCH} runs, any mix of checks.`),
  })
  .refine((b) => new Set(b.runs.map((r) => `${r.check}@${Date.parse(r.ranAt)}`)).size === b.runs.length, {
    message: "each (check, ranAt) appears once per batch",
  });

export type BoxCheckRun = z.infer<typeof BoxCheckRunSchema>;

/** One stored run, as the store returns it (`details`/`label`/`unit`/`reason` only needed on the latest run). */
export interface StoredCheckRun {
  check: string;
  ranAt: Date;
  ok: boolean;
  value: number | null;
  cadenceMinutes: number;
  reason: string | null;
  label: string | null;
  unit: string | null;
  details: Record<string, unknown> | null;
}

export interface BoxChecksInputs {
  /** Every run since the earlier of the window start and the 48 h recent cut, any check. */
  windowRuns: StoredCheckRun[];
  /** The most recent run of each check ever seen (all fields). */
  latestPerCheck: StoredCheckRun[];
}

export interface CheckDailyPoint {
  day: string;
  runs: number;
  failedRuns: number;
  valueMin: number | null;
  valueMax: number | null;
  valueMean: number | null;
  valueLast: number | null;
}

export interface CheckRecentPoint {
  ranAt: string;
  ok: boolean;
  value: number | null;
}

export interface BoxCheckView {
  check: string;
  label: string | null;
  verdict: "broken" | "ok" | "not_yet";
  reason: string;
  stale: boolean;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  minutesSinceLastRun: number | null;
  cadenceMinutes: number | null;
  staleAfterMinutes: number | null;
  /** Since when the check has been failing without interruption (the oldest of the current run of `ok: false`); null when ok. */
  brokenSince: string | null;
  unit: string | null;
  latestValue: number | null;
  latestDetails: Record<string, unknown> | null;
  daily: CheckDailyPoint[];
  recent: CheckRecentPoint[];
}

export interface BoxChecksView {
  status: "red" | "green";
  brokenCount: number;
  reason: string;
  windowDays: number;
  recentHours: number;
  staleCadenceMultiplier: number;
  checks: BoxCheckView[];
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Start of the window: 00:00 UTC of the oldest of the `windowDays` UTC days ending today. */
export function windowStart(now: Date, windowDays: number): Date {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(end - (windowDays - 1) * 86_400_000);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function durationWords(minutes: number): string {
  const m = Math.floor(minutes);
  if (m < 120) return plural(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return plural(h, "hour");
  return plural(Math.floor(h / 24), "day");
}

function buildOne(check: string, latest: StoredCheckRun, runs: StoredCheckRun[], now: Date, windowDays: number): BoxCheckView {
  const nowMs = now.getTime();
  const minutesSince = Math.max(0, (nowMs - latest.ranAt.getTime()) / 60_000);
  const staleAfterMinutes = STALE_CADENCE_MULTIPLIER * latest.cadenceMinutes;
  const stale = minutesSince > staleAfterMinutes;
  const sorted = [...runs].sort((a, b) => a.ranAt.getTime() - b.ranAt.getTime());

  const reasons: string[] = [];
  if (stale) {
    reasons.push(
      `No report for ${durationWords(minutesSince)} (it runs every ${durationWords(latest.cadenceMinutes)}): the check has stopped running.`,
    );
  }
  if (!latest.ok) reasons.push(latest.reason ?? "The last run failed.");
  const broken = reasons.length > 0;
  if (!broken) reasons.push(latest.reason && latest.reason.length > 0 ? latest.reason : "OK.");

  // Since when it has been failing: walk back from the latest run over the uninterrupted `ok: false` runs we hold.
  let brokenSince: string | null = null;
  if (!latest.ok) {
    let since = latest.ranAt;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const r = sorted[i];
      if (r.ranAt.getTime() > latest.ranAt.getTime()) continue;
      if (r.ok) break;
      since = r.ranAt;
    }
    brokenSince = since.toISOString();
  }

  // DAILY: one point per UTC day that HAS runs (a day without runs is absent: a gap, never a zero).
  const start = windowStart(now, windowDays).getTime();
  const byDay = new Map<string, StoredCheckRun[]>();
  for (const r of sorted) {
    if (r.ranAt.getTime() < start) continue;
    const day = utcDayOf(r.ranAt);
    const list = byDay.get(day);
    if (list) list.push(r);
    else byDay.set(day, [r]);
  }
  const daily: CheckDailyPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, rs]) => {
      const values = rs.map((r) => r.value).filter((v): v is number => v != null);
      const withValue = rs.filter((r) => r.value != null);
      return {
        day,
        runs: rs.length,
        failedRuns: rs.filter((r) => !r.ok).length,
        valueMin: values.length === 0 ? null : Math.min(...values),
        valueMax: values.length === 0 ? null : Math.max(...values),
        valueMean: values.length === 0 ? null : round2(values.reduce((t, v) => t + v, 0) / values.length),
        valueLast: withValue.length === 0 ? null : withValue[withValue.length - 1].value,
      };
    });

  const recentCut = nowMs - RECENT_HOURS * 3_600_000;
  const recent: CheckRecentPoint[] = sorted
    .filter((r) => r.ranAt.getTime() > recentCut)
    .map((r) => ({ ranAt: r.ranAt.toISOString(), ok: r.ok, value: r.value }));

  return {
    check,
    label: latest.label,
    verdict: broken ? "broken" : "ok",
    reason: reasons.join(" "),
    stale,
    lastRunAt: latest.ranAt.toISOString(),
    lastRunOk: latest.ok,
    minutesSinceLastRun: round1(minutesSince),
    cadenceMinutes: latest.cadenceMinutes,
    staleAfterMinutes,
    brokenSince,
    unit: latest.unit,
    latestValue: latest.value,
    latestDetails: latest.details,
    daily,
    recent,
  };
}

function notYet(check: string): BoxCheckView {
  return {
    check,
    label: null,
    verdict: "not_yet",
    reason: "This check has not reported a run yet.",
    stale: false,
    lastRunAt: null,
    lastRunOk: null,
    minutesSinceLastRun: null,
    cadenceMinutes: null,
    staleAfterMinutes: null,
    brokenSince: null,
    unit: null,
    latestValue: null,
    latestDetails: null,
    daily: [],
    recent: [],
  };
}

const VERDICT_ORDER: Record<BoxCheckView["verdict"], number> = { broken: 0, ok: 1, not_yet: 2 };

/**
 * Every check seen (plus every `expected` name never seen, as `not_yet`), broken first, then by name.
 */
export function buildBoxChecksView(inputs: BoxChecksInputs, now: Date, windowDays: number, expected: string[] = []): BoxChecksView {
  const runsByCheck = new Map<string, StoredCheckRun[]>();
  for (const r of inputs.windowRuns) {
    const list = runsByCheck.get(r.check);
    if (list) list.push(r);
    else runsByCheck.set(r.check, [r]);
  }
  const checks: BoxCheckView[] = inputs.latestPerCheck.map((latest) =>
    buildOne(latest.check, latest, runsByCheck.get(latest.check) ?? [], now, windowDays),
  );
  const seen = new Set(checks.map((c) => c.check));
  for (const name of new Set(expected)) {
    if (!seen.has(name)) checks.push(notYet(name));
  }
  checks.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.check.localeCompare(b.check));

  const broken = checks.filter((c) => c.verdict === "broken");
  const reason =
    broken.length > 0
      ? broken.map((c) => `${c.label ?? c.check}: ${c.reason}`).join(" ")
      : checks.length === 0
        ? "No check has reported yet."
        : "Every check is OK.";
  return {
    status: broken.length > 0 ? "red" : "green",
    brokenCount: broken.length,
    reason,
    windowDays,
    recentHours: RECENT_HOURS,
    staleCadenceMultiplier: STALE_CADENCE_MULTIPLIER,
    checks,
  };
}
