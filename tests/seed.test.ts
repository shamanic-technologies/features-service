import { describe, it, expect } from "vitest";
import { SEED_FEATURES } from "../src/seed/features.js";
import { upsertFeatureSchema } from "../src/lib/schemas.js";
import { computeSignature } from "../src/lib/signature.js";

describe("SEED_FEATURES", () => {
  it("contains at least 2 features", () => {
    expect(SEED_FEATURES.length).toBeGreaterThanOrEqual(2);
  });

  it("all features pass schema validation", () => {
    for (const f of SEED_FEATURES) {
      const result = upsertFeatureSchema.safeParse(f);
      if (!result.success) {
        throw new Error(`Feature "${f.name}" failed validation: ${JSON.stringify(result.error.flatten())}`);
      }
    }
  });

  it("all features have unique names", () => {
    const names = SEED_FEATURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all features have unique signatures", () => {
    const sigs = SEED_FEATURES.map((f) =>
      computeSignature(
        f.inputs.map((i) => i.key),
        f.outputs.map((o) => o.key),
      ),
    );
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it("Sales Cold Email has 3 inputs and 6 outputs", () => {
    const sales = SEED_FEATURES.find((f) => f.name === "Sales Cold Email Outreach");
    expect(sales).toBeDefined();
    expect(sales!.inputs).toHaveLength(3);
    expect(sales!.outputs).toHaveLength(6);
  });

  it("Sales Cold Email has funnel and breakdown charts", () => {
    const sales = SEED_FEATURES.find((f) => f.name === "Sales Cold Email Outreach");
    expect(sales!.charts).toHaveLength(2);
    expect(sales!.charts![0].type).toBe("funnel-bar");
    expect(sales!.charts![1].type).toBe("breakdown-bar");
  });

  it("Outlet Database Discovery has 4 inputs and resultComponent", () => {
    const outlets = SEED_FEATURES.find((f) => f.name === "Outlet Database Discovery");
    expect(outlets).toBeDefined();
    expect(outlets!.inputs).toHaveLength(4);
    expect(outlets!.resultComponent).toBe("discovered-outlets");
    expect(outlets!.charts).toHaveLength(0);
  });

  it("implemented features have all required fields", () => {
    const implemented = SEED_FEATURES.filter((f) => f.implemented);
    expect(implemented.length).toBeGreaterThanOrEqual(2);
    for (const f of implemented) {
      expect(f.icon).toBeTruthy();
      expect(f.category).toBeTruthy();
      expect(f.channel).toBeTruthy();
      expect(f.inputs.length).toBeGreaterThan(0);
      expect(f.outputs.length).toBeGreaterThan(0);
    }
  });
});
