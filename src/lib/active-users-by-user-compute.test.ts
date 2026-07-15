import { describe, it, expect } from "vitest";

// active-users-by-user-compute transitively imports accounts-compute → pipeline-activity → the db module.
// Stub it so this pure-logic suite needs no DB connection (all reads are injected).
import { vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import {
  buildActiveUsersByUser,
  summarizeUser,
  INCEPTION_ISO,
  type ActiveUsersByUserDeps,
} from "./active-users-by-user-compute.js";
import type { OrgIdentity, BrandBasic } from "./accounts-client.js";

const NOW = new Date("2026-07-15T12:00:00Z"); // Wednesday, ISO week 2026-W29, month 2026-07
const COLD = "sales-cold-email-outreach,pr-cold-email-outreach";

const IDENTITY = (i: number): OrgIdentity => ({ orgExternalId: `org_${i}`, ownerEmail: `owner${i}@x.com` });

describe("summarizeUser — pure per-user derivation", () => {
  it("derives first/last month+week+day, retention span, and current-period flags", () => {
    // Active on: 2026-05-20 (W21), 2026-06-01 (W23), 2026-07-15 (W29, current week+month).
    const row = summarizeUser(
      "orgA",
      new Set(["2026-07-15", "2026-05-20", "2026-06-01"]),
      [{ brandId: "b1", brandName: "Brand One", brandDomain: "one.com" }],
      IDENTITY(1),
      "2026-W29",
      "2026-07",
    );
    expect(row.firstActiveDay).toBe("2026-05-20");
    expect(row.lastActiveDay).toBe("2026-07-15");
    expect(row.firstActiveMonth).toBe("2026-05");
    expect(row.lastActiveMonth).toBe("2026-07");
    expect(row.firstActiveWeek).toBe("2026-W21");
    expect(row.lastActiveWeek).toBe("2026-W29");
    expect(row.activeMonths).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(row.activeWeeks).toEqual(["2026-W21", "2026-W23", "2026-W29"]);
    expect(row.activeDays).toEqual(["2026-05-20", "2026-06-01", "2026-07-15"]);
    // W21 Monday = 2026-05-18, W29 Monday = 2026-07-13 → (13 Jul − 18 May)/7 + 1 = 8 + 1 = 9 weeks.
    expect(row.retentionWeeks).toBe(9);
    expect(row.activeThisWeek).toBe(true);
    expect(row.activeThisMonth).toBe(true);
    expect(row.orgExternalId).toBe("org_1");
    expect(row.ownerEmail).toBe("owner1@x.com");
  });

  it("a user active in exactly one week has retentionWeeks === 1 (inclusive span, never 0)", () => {
    const row = summarizeUser("orgB", new Set(["2026-03-04", "2026-03-06"]), [], IDENTITY(2), "2026-W29", "2026-07");
    expect(row.firstActiveWeek).toBe(row.lastActiveWeek);
    expect(row.retentionWeeks).toBe(1);
    expect(row.activeThisWeek).toBe(false);
    expect(row.activeThisMonth).toBe(false);
  });

  it("counts an org active twice in the same day/week/month once per bucket", () => {
    const row = summarizeUser("orgC", new Set(["2026-07-13", "2026-07-15"]), [], IDENTITY(3), "2026-W29", "2026-07");
    expect(row.activeDays).toEqual(["2026-07-13", "2026-07-15"]);
    expect(row.activeWeeks).toEqual(["2026-W29"]); // both days in the same ISO week
    expect(row.activeMonths).toEqual(["2026-07"]);
    expect(row.retentionWeeks).toBe(1);
  });
});

describe("buildActiveUsersByUser — integration via injected deps", () => {
  function deps(fixture: {
    memberships: Array<{ orgId: string; brandId: string }>;
    activeDays: Record<string, string[]>;
    brands?: Record<string, BrandBasic>;
    capture?: { startedAfter?: string };
  }): ActiveUsersByUserDeps {
    return {
      featureMemberships: async () => fixture.memberships,
      orgActiveDays: async (orgId, _csv, startedAfterIso) => {
        if (fixture.capture) fixture.capture.startedAfter = startedAfterIso;
        return new Set(fixture.activeDays[orgId] ?? []);
      },
      orgIdentity: async (orgId) => ({ orgExternalId: `ext_${orgId}`, ownerEmail: `${orgId}@x.com` }),
      brandsBasic: async (ids) => new Map(ids.map((id) => [id, fixture.brands?.[id] ?? { name: null, domain: null }])),
    };
  }

  it("emits one row per EVER-active org, groups brands, and computes tab counts", async () => {
    const capture: { startedAfter?: string } = {};
    const out = await buildActiveUsersByUser(
      COLD,
      NOW,
      deps({
        memberships: [
          { orgId: "orgA", brandId: "b1" },
          { orgId: "orgA", brandId: "b2" }, // two brands, one org
          { orgId: "orgB", brandId: "b3" },
          { orgId: "orgNever", brandId: "b4" }, // in universe but no active days → omitted
        ],
        activeDays: {
          orgA: ["2026-07-15", "2026-06-10"], // active this week + this month
          orgB: ["2026-04-02"], // active in the past only
          orgNever: [],
        },
        brands: {
          b1: { name: "One", domain: "one.com" },
          b2: { name: "Two", domain: "two.com" },
          b3: { name: "Three", domain: "three.com" },
        },
        capture,
      }),
    );

    expect(capture.startedAfter).toBe(INCEPTION_ISO); // reads from inception, not a trailing window
    expect(out.currentWeek).toBe("2026-W29");
    expect(out.currentMonth).toBe("2026-07");
    expect(out.users.map((u) => u.orgId)).toEqual(["orgA", "orgB"]); // orgNever omitted; orgA most-recent first
    expect(out.stats).toEqual({ totalUsers: 2, activeThisWeekCount: 1, activeThisMonthCount: 1 });

    const orgA = out.users[0];
    expect(orgA.brands.map((b) => b.brandId).sort()).toEqual(["b1", "b2"]);
    expect(orgA.brands.find((b) => b.brandId === "b1")).toEqual({ brandId: "b1", brandName: "One", brandDomain: "one.com" });
    expect(orgA.activeThisWeek).toBe(true);
    expect(orgA.orgExternalId).toBe("ext_orgA");

    const orgB = out.users[1];
    expect(orgB.activeThisWeek).toBe(false);
    expect(orgB.activeThisMonth).toBe(false);
    expect(orgB.lastActiveMonth).toBe("2026-04");
  });

  it("sorts most-recently-active first", async () => {
    const out = await buildActiveUsersByUser(
      COLD,
      NOW,
      deps({
        memberships: [
          { orgId: "old", brandId: "b1" },
          { orgId: "recent", brandId: "b2" },
        ],
        activeDays: { old: ["2026-01-05"], recent: ["2026-07-14"] },
      }),
    );
    expect(out.users.map((u) => u.orgId)).toEqual(["recent", "old"]);
  });

  it("empty cold-email universe → zero users, zero stats, never throws", async () => {
    const out = await buildActiveUsersByUser("", NOW, deps({ memberships: [], activeDays: {} }));
    expect(out.users).toEqual([]);
    expect(out.stats).toEqual({ totalUsers: 0, activeThisWeekCount: 0, activeThisMonthCount: 0 });
    expect(out.currentMonth).toBe("2026-07");
  });
});
