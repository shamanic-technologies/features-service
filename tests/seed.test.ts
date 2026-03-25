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

  it("Sales Cold Email has 7 inputs and 7 outputs", () => {
    const sales = SEED_FEATURES.find((f) => f.name === "Sales Cold Email Outreach");
    expect(sales).toBeDefined();
    expect(sales!.inputs).toHaveLength(7);
    expect(sales!.outputs).toHaveLength(7);
  });

  it("Sales Cold Email has funnel and breakdown charts", () => {
    const sales = SEED_FEATURES.find((f) => f.name === "Sales Cold Email Outreach");
    expect(sales!.charts).toHaveLength(2);
    expect(sales!.charts[0].type).toBe("funnel-bar");
    expect(sales!.charts[1].type).toBe("breakdown-bar");
  });

  it("Sales Cold Email has correct entities", () => {
    const sales = SEED_FEATURES.find((f) => f.name === "Sales Cold Email Outreach");
    expect(sales!.entities).toEqual(["leads", "companies", "emails"]);
  });

  it("Outlet Database Discovery has 3 inputs and entities", () => {
    const outlets = SEED_FEATURES.find((f) => f.name === "Outlet Database Discovery");
    expect(outlets).toBeDefined();
    expect(outlets!.inputs).toHaveLength(3);
    expect(outlets!.entities).toEqual(["outlets"]);
  });

  it("Outlet Database Discovery has charts (funnel + breakdown)", () => {
    const outlets = SEED_FEATURES.find((f) => f.name === "Outlet Database Discovery");
    expect(outlets!.charts).toHaveLength(2);
    expect(outlets!.charts[0].type).toBe("funnel-bar");
    expect(outlets!.charts[1].type).toBe("breakdown-bar");
  });

  it("PR Cold Email Outreach has 5 inputs and 7 outputs", () => {
    const pr = SEED_FEATURES.find((f) => f.name === "PR Cold Email Outreach");
    expect(pr).toBeDefined();
    expect(pr!.inputs).toHaveLength(5);
    expect(pr!.outputs).toHaveLength(7);
    expect(pr!.category).toBe("pr");
    expect(pr!.channel).toBe("email");
  });

  it("PR Cold Email Outreach has funnel and breakdown charts", () => {
    const pr = SEED_FEATURES.find((f) => f.name === "PR Cold Email Outreach");
    expect(pr!.charts).toHaveLength(2);
    expect(pr!.charts[0].type).toBe("funnel-bar");
    expect(pr!.charts[1].type).toBe("breakdown-bar");
  });

  it("PR Cold Email Outreach has correct entities", () => {
    const pr = SEED_FEATURES.find((f) => f.name === "PR Cold Email Outreach");
    expect(pr!.entities).toEqual(["leads", "journalists", "emails", "press-kits"]);
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
      expect(f.charts.length).toBeGreaterThan(0);
      expect(f.entities.length).toBeGreaterThan(0);
    }
  });

  it("no feature has removed fields (workflowColumns, resultComponent, defaultWorkflowName)", () => {
    for (const f of SEED_FEATURES) {
      const raw = f as Record<string, unknown>;
      expect(raw.workflowColumns).toBeUndefined();
      expect(raw.resultComponent).toBeUndefined();
      expect(raw.defaultWorkflowName).toBeUndefined();
    }
  });
});
