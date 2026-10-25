import { describe, it, expect } from "vitest";
import {
  SecurityAdvisoryReportSchema,
  buildSecurityAdvisoriesView,
  windowDaysEnding,
  type StoredAdvisoryRow,
} from "./security-advisories.js";

const NOW = new Date("2026-10-25T10:00:00Z");

function row(day: string, repo: string, over: Partial<StoredAdvisoryRow> = {}): StoredAdvisoryRow {
  return {
    day,
    repo,
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    packages: [],
    error: null,
    reportedAt: new Date(`${day}T04:30:00Z`),
    ...over,
  };
}

describe("report body", () => {
  it("accepts counts, or an error without counts", () => {
    const ok = SecurityAdvisoryReportSchema.safeParse({
      day: "2026-10-25",
      repos: [
        { repo: "a", critical: 0, high: 1, moderate: 2, low: 3, packages: ["lodash"] },
        { repo: "b", error: "pnpm audit exited 1: ENOTFOUND" },
      ],
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.repos[1].packages).toEqual([]);
  });

  it("refuses missing counts without an error, a duplicate repo, a bad day, an empty report", () => {
    expect(SecurityAdvisoryReportSchema.safeParse({ repos: [{ repo: "a", critical: 1 }] }).success).toBe(false);
    expect(
      SecurityAdvisoryReportSchema.safeParse({
        repos: [
          { repo: "a", critical: 0, high: 0, moderate: 0, low: 0 },
          { repo: "a", critical: 0, high: 0, moderate: 0, low: 0 },
        ],
      }).success,
    ).toBe(false);
    expect(SecurityAdvisoryReportSchema.safeParse({ day: "2026-13-45", repos: [{ repo: "a", error: "x" }] }).success).toBe(false);
    expect(SecurityAdvisoryReportSchema.safeParse({ repos: [] }).success).toBe(false);
    expect(SecurityAdvisoryReportSchema.safeParse({ repos: [{ repo: "a", critical: -1, high: 0, moderate: 0, low: 0 }] }).success).toBe(false);
  });
});

describe("verdict", () => {
  it("is red with a plain reason when nothing was ever reported (never 'all clean')", () => {
    const v = buildSecurityAdvisoriesView([], NOW, 7);
    expect(v.status).toBe("red");
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("No security audit report has arrived yet.");
    expect(v.lastReportAt).toBeNull();
    expect(v.daily).toHaveLength(7);
    expect(v.daily.every((d) => !d.reported && d.critical === null)).toBe(true);
    expect(v.repos).toEqual([]);
  });

  it("is green when today's report is clean of critical and high (moderate/low do not turn it red)", () => {
    const v = buildSecurityAdvisoriesView([row("2026-10-25", "a", { moderate: 4, low: 9 }), row("2026-10-25", "b")], NOW, 7);
    expect(v.status).toBe("green");
    expect(v.redRepos).toEqual([]);
    expect(v.reason).toBe("All 2 repos free of critical and high advisories on 2026-10-25.");
    expect(v.lastReportAt).toBe("2026-10-25T04:30:00.000Z");
    expect(v.hoursSinceLastReport).toBe(5.5);
  });

  it("is red naming each repo with a critical/high finding or a failed audit", () => {
    const v = buildSecurityAdvisoriesView(
      [
        row("2026-10-25", "zeta", { critical: 1, high: 2, packages: ["next", "axios"] }),
        row("2026-10-25", "alpha", { critical: null, high: null, moderate: null, low: null, error: "lockfile missing" }),
        row("2026-10-25", "clean"),
      ],
      NOW,
      7,
    );
    expect(v.status).toBe("red");
    expect(v.stale).toBe(false);
    expect(v.redRepos.map((r) => r.repo)).toEqual(["alpha", "zeta"]);
    expect(v.reason).toBe(
      "2 repos need attention on 2026-10-25: alpha (audit could not run: lockfile missing); zeta (1 critical, 2 high (next, axios)).",
    );
    expect(v.repos.map((r) => [r.repo, r.status])).toEqual([
      ["alpha", "red"],
      ["zeta", "red"],
      ["clean", "green"],
    ]);
    const today = v.daily[v.daily.length - 1];
    expect(today).toMatchObject({ day: "2026-10-25", reported: true, repoCount: 3, critical: 1, high: 2, failedAudits: 1, redRepoCount: 2 });
  });

  it("agrees the verb with the count: 1 repo needs, 2 repos need", () => {
    const one = buildSecurityAdvisoriesView([row("2026-10-25", "a", { high: 1 })], NOW, 7);
    expect(one.reason).toBe("1 repo needs attention on 2026-10-25: a (1 high).");
    const two = buildSecurityAdvisoriesView(
      [row("2026-10-25", "a", { high: 1 }), row("2026-10-25", "b", { critical: 1 })],
      NOW,
      7,
    );
    expect(two.reason).toBe("2 repos need attention on 2026-10-25: a (1 high); b (1 critical).");
  });

  it("is red when the latest report is older than 36 hours, even if it was clean", () => {
    const v = buildSecurityAdvisoriesView([row("2026-10-23", "a")], NOW, 7);
    expect(v.status).toBe("red");
    expect(v.stale).toBe(true);
    expect(v.reason).toBe("No report for 53 hours (last one 2026-10-23T04:30:00.000Z): the daily audit job may have stopped.");
    expect(buildSecurityAdvisoriesView([row("2026-10-24", "a")], NOW, 7).status).toBe("green");
  });

  it("reads the latest report even when it is older than the window", () => {
    const v = buildSecurityAdvisoriesView([row("2026-09-01", "a", { high: 3 })], NOW, 7);
    expect(v.latestDay).toBe("2026-09-01");
    expect(v.redRepos.map((r) => r.repo)).toEqual(["a"]);
    expect(v.reason).toMatch(/^No report for \d+ hours .* 1 repo needs attention on 2026-09-01: a \(3 high\)\.$/);
    expect(v.repos[0].series.every((p) => p.status === "missing")).toBe(true);
  });

  it("serves one point per window day per repo, a missing day as missing (never 0)", () => {
    const v = buildSecurityAdvisoriesView([row("2026-10-23", "a", { high: 1 }), row("2026-10-25", "a")], NOW, 3);
    expect(v.days).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(v.repos[0].series.map((p) => [p.day, p.status, p.high])).toEqual([
      ["2026-10-23", "red", 1],
      ["2026-10-24", "missing", null],
      ["2026-10-25", "green", 0],
    ]);
    expect(v.daily.map((d) => d.reported)).toEqual([true, false, true]);
  });

  it("keeps a repo dropped from the latest report as missing, never red", () => {
    const v = buildSecurityAdvisoriesView([row("2026-10-24", "old", { critical: 5 }), row("2026-10-25", "a")], NOW, 7);
    expect(v.status).toBe("green");
    expect(v.repos.find((r) => r.repo === "old")).toMatchObject({ status: "missing", inLatestReport: false, latest: null });
  });

  it("windowDaysEnding counts UTC days ending today", () => {
    expect(windowDaysEnding(new Date("2026-03-01T23:59:00Z"), 2)).toEqual(["2026-02-28", "2026-03-01"]);
  });
});
