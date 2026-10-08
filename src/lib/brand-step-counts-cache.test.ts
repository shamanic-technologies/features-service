import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./view-cache.js", async (orig) => ({
  ...(await orig<typeof import("./view-cache.js")>()),
  servedCached: vi.fn(async () => ({ counts: [] })),
}));

const { servedCached } = await import("./view-cache.js");
const { getBrandStepCounts } = await import("./effective-conversion-rates.js");

describe("getBrandStepCounts Gold cell", () => {
  it("is keyed on its measurement rule, never on the build's response shape (a deploy must not make it cold)", async () => {
    await getBrandStepCounts("b1", "org1");
    const args = vi.mocked(servedCached).mock.calls[0][0];
    expect(args.view).toBe("brand-conversion-step-counts");
    expect(args.scopeKey).toContain("m=funnel-step-crm-through-leg-v2");
    expect(args.responseShape).toBe("internal-measurement");
  });
});
