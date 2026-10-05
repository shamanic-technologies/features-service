import { describe, it, expect, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { parseContactedValuePage, pageContactedValue } from "./contacted-value.js";
import type { ContactedValueResult } from "../lib/contacted-value.js";

function result(n: number): ContactedValueResult {
  return {
    lifetimeRevenueUsd: 1000,
    perLeadExpectedValueUsd: 4,
    totalExpectedValueUsd: 4 * n,
    unmeasuredReason: null,
    routes: [],
    workflows: [],
    expiryDays: 30,
    lastSentOnOrAfter: "2026-08-27T12:00:00.000Z",
    population: { contactedOnly: n, organizations: n, engaged: 0, cannotConvert: 0, expired: 0, unattributed: 0, unpriced: 0 },
    leads: Array.from({ length: n }, (_, i) => ({
      leadId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      expectedValueUsd: 3.996004,
      expired: false,
    })),
  };
}

describe("contacted-value paging", () => {
  it("defaults to 1000 rows and walks the whole population with nextCursor", () => {
    const r = result(2500);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = parseContactedValuePage(cursor ? { cursor } : {});
      if ("error" in page) throw new Error(page.error);
      const body = pageContactedValue(r, page);
      expect(body.totalExpectedValueUsd).toBe(10_000); // the summary rides every page
      seen.push(...body.leads.map((l) => l.leadId));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(seen).toEqual(r.leads.map((l) => l.leadId));
  });

  it("leadIds prices exactly the named cards", () => {
    const r = result(10);
    const page = parseContactedValuePage({ leadIds: `${r.leads[3].leadId},${r.leads[7].leadId},unknown` });
    if ("error" in page) throw new Error(page.error);
    expect(pageContactedValue(r, page).leads.map((l) => l.leadId)).toEqual([r.leads[3].leadId, r.leads[7].leadId]);
  });

  it("a max page of the largest brand stays far under the 2MB cache limit", () => {
    const page = parseContactedValuePage({ limit: "5000" });
    if ("error" in page) throw new Error(page.error);
    const bytes = JSON.stringify(pageContactedValue(result(16_000), page)).length;
    expect(bytes).toBeLessThan(500_000);
  });

  it.each([{ limit: "0" }, { limit: "5001" }, { limit: "x" }, { cursor: "-1" }, { leadIds: "a", cursor: "10" }])(
    "refuses %o",
    (q) => {
      expect("error" in parseContactedValuePage(q)).toBe(true);
    },
  );
});
