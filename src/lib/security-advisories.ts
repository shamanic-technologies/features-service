/**
 * SECURITY ADVISORIES MONITOR (SEC-ADVISORIES-SERIES-1025). The owner's daily audit job (npm/pnpm audit over every repo
 * running in prod) posts ONE report per day; it is stored per (day, repo) (`security_advisory_reports`) and served to the
 * staff Monitoring hub with a VERDICT the dashboard renders as-is. Pure: no DB, no clock (the caller passes `now`).
 *
 * Red when (1) the latest report holds any repo with a critical or high finding or an audit that could not run, OR (2) no
 * report arrived for more than `STALE_AFTER_HOURS` (a silent job is loud, never read as "all clean"), OR (3) nothing was
 * ever reported.
 */
import { z } from "zod";

export const STALE_AFTER_HOURS = 36;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 365;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const count = z.number().int().min(0);

export const SecurityAdvisoryRepoReportSchema = z
  .object({
    repo: z.string().trim().min(1).max(200).describe("Repo name, e.g. `features-service`."),
    critical: count.nullable().optional().describe("Open critical advisories. Required unless `error` is set."),
    high: count.nullable().optional().describe("Open high advisories. Required unless `error` is set."),
    moderate: count.nullable().optional().describe("Open moderate advisories. Required unless `error` is set."),
    low: count.nullable().optional().describe("Open low advisories. Required unless `error` is set."),
    packages: z.array(z.string().min(1)).max(500).default([]).describe("Package names with a high or critical finding."),
    error: z
      .string()
      .min(1)
      .max(2000)
      .nullable()
      .optional()
      .describe("Why the audit could not run for this repo (counts may then be null). A repo with an error is red."),
  })
  .refine(
    (r) => (r.error != null && r.error !== "") || [r.critical, r.high, r.moderate, r.low].every((c) => typeof c === "number"),
    { message: "critical, high, moderate and low are required when error is not set" },
  );

export const SecurityAdvisoryReportSchema = z
  .object({
    day: z
      .string()
      .regex(DAY_RE)
      .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), { message: "day must be a real calendar day" })
      .optional()
      .describe("UTC day the report is for (`YYYY-MM-DD`). Defaults to today (UTC). Re-sending a day replaces it."),
    repos: z.array(SecurityAdvisoryRepoReportSchema).min(1).max(500).describe("Every prod repo audited, one entry each."),
  })
  .refine((b) => new Set(b.repos.map((r) => r.repo)).size === b.repos.length, { message: "each repo appears once" });

export type SecurityAdvisoryReport = z.infer<typeof SecurityAdvisoryReportSchema>;
export type SecurityAdvisoryRepoReport = z.infer<typeof SecurityAdvisoryRepoReportSchema>;

/** One stored (day, repo) row, as the store returns it. */
export interface StoredAdvisoryRow {
  day: string;
  repo: string;
  critical: number | null;
  high: number | null;
  moderate: number | null;
  low: number | null;
  packages: string[];
  error: string | null;
  reportedAt: Date;
}

export type PointStatus = "red" | "green" | "missing";

export interface RepoDayPoint {
  day: string;
  status: PointStatus;
  critical: number | null;
  high: number | null;
  moderate: number | null;
  low: number | null;
  packages: string[];
  error: string | null;
}

export interface FleetDayPoint {
  day: string;
  reported: boolean;
  repoCount: number;
  critical: number | null;
  high: number | null;
  moderate: number | null;
  low: number | null;
  failedAudits: number;
  redRepoCount: number;
}

export interface RedRepo {
  repo: string;
  reason: string;
  critical: number | null;
  high: number | null;
  packages: string[];
  error: string | null;
}

export interface SecurityAdvisoriesView {
  status: "red" | "green";
  reason: string;
  staleAfterHours: number;
  stale: boolean;
  lastReportAt: string | null;
  hoursSinceLastReport: number | null;
  latestDay: string | null;
  redRepos: RedRepo[];
  windowDays: number;
  days: string[];
  daily: FleetDayPoint[];
  repos: Array<{ repo: string; status: PointStatus; inLatestReport: boolean; latest: RepoDayPoint | null; series: RepoDayPoint[] }>;
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The `n` UTC days ending today, oldest first. */
export function windowDaysEnding(now: Date, n: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: n }, (_, i) => utcDayOf(new Date(end - (n - 1 - i) * 86_400_000)));
}

export function isRedRow(r: Pick<StoredAdvisoryRow, "critical" | "high" | "error">): boolean {
  return r.error != null || (r.critical ?? 0) > 0 || (r.high ?? 0) > 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function redReasonOf(r: StoredAdvisoryRow): string {
  if (r.error != null) return `audit could not run: ${r.error}`;
  const parts: string[] = [];
  if ((r.critical ?? 0) > 0) parts.push(`${r.critical} critical`);
  if ((r.high ?? 0) > 0) parts.push(`${r.high} high`);
  const pkgs = r.packages.length > 0 ? ` (${r.packages.join(", ")})` : "";
  return `${parts.join(", ")}${pkgs}`;
}

function pointOf(day: string, r: StoredAdvisoryRow | undefined): RepoDayPoint {
  if (!r) return { day, status: "missing", critical: null, high: null, moderate: null, low: null, packages: [], error: null };
  return {
    day,
    status: isRedRow(r) ? "red" : "green",
    critical: r.critical,
    high: r.high,
    moderate: r.moderate,
    low: r.low,
    packages: r.packages,
    error: r.error,
  };
}

function sumOf(rows: StoredAdvisoryRow[], key: "critical" | "high" | "moderate" | "low"): number | null {
  const known = rows.filter((r) => r[key] != null);
  return known.length === 0 ? null : known.reduce((s, r) => s + (r[key] as number), 0);
}

/**
 * The served view. `rows` = every stored row of the window PLUS the rows of the latest reported day (even when older
 * than the window), so the verdict always reads the latest report.
 */
export function buildSecurityAdvisoriesView(rows: StoredAdvisoryRow[], now: Date, windowDays: number): SecurityAdvisoriesView {
  const days = windowDaysEnding(now, windowDays);
  const byDay = new Map<string, StoredAdvisoryRow[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);

  const latestDay = rows.length === 0 ? null : rows.reduce((m, r) => (r.day > m ? r.day : m), rows[0].day);
  const latestRows = latestDay ? (byDay.get(latestDay) ?? []) : [];
  const lastReportAtMs = latestRows.length === 0 ? null : Math.max(...latestRows.map((r) => r.reportedAt.getTime()));
  const hoursSince = lastReportAtMs == null ? null : Math.max(0, (now.getTime() - lastReportAtMs) / 3_600_000);
  const stale = hoursSince == null || hoursSince > STALE_AFTER_HOURS;

  const redRepos: RedRepo[] = latestRows
    .filter(isRedRow)
    .sort((a, b) => a.repo.localeCompare(b.repo))
    .map((r) => ({ repo: r.repo, reason: redReasonOf(r), critical: r.critical, high: r.high, packages: r.packages, error: r.error }));

  const reasons: string[] = [];
  if (lastReportAtMs == null) {
    reasons.push("No security audit report has arrived yet.");
  } else if (stale) {
    reasons.push(
      `No report for ${Math.floor(hoursSince!)} hours (last one ${new Date(lastReportAtMs).toISOString()}): the daily audit job may have stopped.`,
    );
  }
  if (redRepos.length > 0) {
    reasons.push(
      `${plural(redRepos.length, "repo")} need attention on ${latestDay}: ${redRepos.map((r) => `${r.repo} (${r.reason})`).join("; ")}.`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(`All ${plural(latestRows.length, "repo")} free of critical and high advisories on ${latestDay}.`);
  }

  const daily: FleetDayPoint[] = days.map((day) => {
    const dr = byDay.get(day) ?? [];
    return {
      day,
      reported: dr.length > 0,
      repoCount: dr.length,
      critical: sumOf(dr, "critical"),
      high: sumOf(dr, "high"),
      moderate: sumOf(dr, "moderate"),
      low: sumOf(dr, "low"),
      failedAudits: dr.filter((r) => r.error != null).length,
      redRepoCount: dr.filter(isRedRow).length,
    };
  });

  const latestByRepo = new Map(latestRows.map((r) => [r.repo, r]));
  const repoNames = new Set<string>(latestRows.map((r) => r.repo));
  const windowSet = new Set(days);
  for (const r of rows) if (windowSet.has(r.day)) repoNames.add(r.repo);
  const rowAt = new Map(rows.map((r) => [`${r.day}|${r.repo}`, r]));

  const repos = [...repoNames]
    .map((repo) => {
      const lr = latestByRepo.get(repo);
      const latest = lr ? pointOf(lr.day, lr) : null;
      return {
        repo,
        status: (latest?.status ?? "missing") as PointStatus,
        inLatestReport: lr != null,
        latest,
        series: days.map((day) => pointOf(day, rowAt.get(`${day}|${repo}`))),
      };
    })
    .sort((a, b) => {
      const rank = (s: PointStatus) => (s === "red" ? 0 : s === "green" ? 1 : 2);
      return rank(a.status) - rank(b.status) || a.repo.localeCompare(b.repo);
    });

  return {
    status: stale || redRepos.length > 0 ? "red" : "green",
    reason: reasons.join(" "),
    staleAfterHours: STALE_AFTER_HOURS,
    stale,
    lastReportAt: lastReportAtMs == null ? null : new Date(lastReportAtMs).toISOString(),
    hoursSinceLastReport: hoursSince == null ? null : Math.round(hoursSince * 10) / 10,
    latestDay,
    redRepos,
    windowDays,
    days,
    daily,
    repos,
  };
}
