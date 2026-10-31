import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { parseRow } from "./fleet-return-store.js";

const base = { brandId: "b1", committedSpendUsd: 120, expectedPipelineUsd: 300, isMature: true };

describe("fleet-return snapshot rows (PUBLIC-VENDOR-COST-1031)", () => {
  it("keeps the vendor ingredients the warm wrote (the public vendor ROI median reads them)", () => {
    const vendorSpend = { flashUsd: 80, matureUsd: 50, unpricedFlashUsd: 0, unpricedMatureUsd: 0 };
    expect(parseRow({ ...base, vendorSpend })).toMatchObject({ vendorSpend });
    expect(parseRow({ ...base, vendorSpend: null })).toMatchObject({ vendorSpend: null });
    expect(parseRow(base)).not.toHaveProperty("vendorSpend");
  });

  it("a malformed vendor block makes the row malformed", () => {
    expect(parseRow({ ...base, vendorSpend: { flashUsd: 80 } })).toBeNull();
  });
});
