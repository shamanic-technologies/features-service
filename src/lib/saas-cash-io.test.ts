import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { parseFleetCashByDay } = await import("./saas-cash-io.js");

describe("parseFleetCashByDay", () => {
  it("reads billing's gross + net per org per day and both fleet totals", () => {
    expect(
      parseFleetCashByDay({
        as_of: "2026-11-21T10:00:00Z",
        total_gross_cents: "1200.5",
        total_net_cents: "1000",
        rows: [
          { org_id: "o1", day: "2026-11-20", gross_cents: "1200.5", net_cents: "1200.5" },
          { org_id: null, day: "2026-11-21", gross_cents: "0", net_cents: "-200.5" },
        ],
      }),
    ).toEqual({
      asOf: "2026-11-21T10:00:00Z",
      totalGrossCents: "1200.5",
      totalNetCents: "1000",
      rows: [
        { orgId: "o1", day: "2026-11-20", grossCents: "1200.5", netCents: "1200.5" },
        { orgId: null, day: "2026-11-21", grossCents: "0", netCents: "-200.5" },
      ],
    });
  });

  it("fails loud when billing serves no gross figure", () => {
    expect(() =>
      parseFleetCashByDay({ as_of: "x", total_net_cents: "1", rows: [] }),
    ).toThrow(/total_gross_cents/);
    expect(() =>
      parseFleetCashByDay({
        as_of: "x",
        total_gross_cents: "1",
        total_net_cents: "1",
        rows: [{ org_id: "o", day: "2026-11-20", net_cents: "1" }],
      }),
    ).toThrow(/gross_cents/);
  });
});
