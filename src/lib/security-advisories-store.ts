/**
 * Persistence of the daily security audit reports (`security_advisory_reports`, `lib/security-advisories.ts`). One
 * report = one day: writing a day REPLACES every row of that day in one transaction (idempotent re-send; a repo the new
 * report no longer lists is gone from that day).
 */
import { desc, eq, gte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { securityAdvisoryReports } from "../db/schema.js";
import type { SecurityAdvisoryRepoReport, StoredAdvisoryRow } from "./security-advisories.js";

export async function replaceSecurityAdvisoryDay(day: string, repos: SecurityAdvisoryRepoReport[], now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(securityAdvisoryReports).where(eq(securityAdvisoryReports.day, day));
    await tx.insert(securityAdvisoryReports).values(
      repos.map((r) => ({
        day,
        repo: r.repo,
        critical: r.critical ?? null,
        high: r.high ?? null,
        moderate: r.moderate ?? null,
        low: r.low ?? null,
        packages: r.packages,
        error: r.error ?? null,
        reportedAt: now,
      })),
    );
  });
}

/** Every row from `sinceDay` on, plus every row of the latest reported day (even older than `sinceDay`). */
export async function readSecurityAdvisoryRows(sinceDay: string): Promise<StoredAdvisoryRow[]> {
  const [latest] = await db
    .select({ day: securityAdvisoryReports.day })
    .from(securityAdvisoryReports)
    .orderBy(desc(securityAdvisoryReports.day))
    .limit(1);
  const where = latest && latest.day < sinceDay
    ? or(gte(securityAdvisoryReports.day, sinceDay), eq(securityAdvisoryReports.day, latest.day))
    : gte(securityAdvisoryReports.day, sinceDay);
  const rows = await db.select().from(securityAdvisoryReports).where(where);
  return rows.map((r) => ({
    day: r.day,
    repo: r.repo,
    critical: r.critical,
    high: r.high,
    moderate: r.moderate,
    low: r.low,
    packages: r.packages ?? [],
    error: r.error,
    reportedAt: r.reportedAt,
  }));
}
