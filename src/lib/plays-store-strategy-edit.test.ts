// STRATEGY-EDIT-PUBLIC-1014: a strategy edit follows the create's rules (known tactics, never both, at least one,
// description and rule unique among the OTHER strategies).
import { describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
  tactics: [
    { id: "catch-all", name: "Catch-all", description: "catch-all words", createdBy: "t", createdAt: new Date(0), updatedBy: null, updatedAt: null },
    { id: "unknown-email", name: "Unknown email", description: "unknown words", createdBy: "t", createdAt: new Date(0), updatedBy: null, updatedAt: null },
  ],
  strategies: [
    { id: "valid-only", name: "Valid only", description: "only confirmed", requiresTacticIds: [], excludesTacticIds: ["catch-all"], createdBy: "t", createdAt: new Date(0), updatedBy: null, updatedAt: null },
    { id: "valid-catch-all", name: "Valid + Catch-all", description: "confirmed and catch-all", requiresTacticIds: ["catch-all"], excludesTacticIds: [], createdBy: "t", createdAt: new Date(0), updatedBy: null, updatedAt: null },
    { id: "valid-catch-all-unknown", name: "Valid + Catch-all + Unknown", description: "all three", requiresTacticIds: ["catch-all", "unknown-email"], excludesTacticIds: [], createdBy: "t", createdAt: new Date(0), updatedBy: null, updatedAt: null },
  ],
}));

vi.unmock("./plays-store.js");

vi.mock("../db/index.js", async () => {
  const schema = await import("../db/schema.js");
  return {
    db: {
      select: () => ({ from: async (table: unknown) => (table === schema.tactics ? rows.tactics : table === schema.strategies ? rows.strategies : []) }),
    },
    sql: {},
  };
});

const { proposeStrategyEdit } = await import("./plays-store.js");

describe("proposeStrategyEdit", () => {
  it("narrows Valid + Catch-all to exclude unknown emails", async () => {
    const r = await proposeStrategyEdit({ id: "valid-catch-all", excludesTacticIds: ["unknown-email"], updatedBy: "s" });
    expect(r.changed).toBe(true);
    expect(r.next).toMatchObject({ requiresTacticIds: ["catch-all"], excludesTacticIds: ["unknown-email"], description: "confirmed and catch-all" });
  });

  it("the same rule = unchanged", async () => {
    const r = await proposeStrategyEdit({ id: "valid-only", excludesTacticIds: ["catch-all"], updatedBy: "s" });
    expect(r.changed).toBe(false);
  });

  it("refuses a rule another strategy holds, a description another holds, unknown tactics, both, and empty", async () => {
    await expect(proposeStrategyEdit({ id: "valid-catch-all", requiresTacticIds: ["catch-all", "unknown-email"], updatedBy: "s" })).rejects.toMatchObject({ status: 409, reason: "strategy_rule_taken" });
    await expect(proposeStrategyEdit({ id: "valid-catch-all", description: "ONLY CONFIRMED", updatedBy: "s" })).rejects.toMatchObject({ status: 409, reason: "strategy_description_taken" });
    await expect(proposeStrategyEdit({ id: "valid-catch-all", excludesTacticIds: ["nope"], updatedBy: "s" })).rejects.toMatchObject({ status: 404, reason: "tactic_not_found" });
    await expect(proposeStrategyEdit({ id: "valid-catch-all", excludesTacticIds: ["catch-all"], updatedBy: "s" })).rejects.toMatchObject({ status: 400, reason: "tactic_required_and_excluded" });
    await expect(proposeStrategyEdit({ id: "valid-only", excludesTacticIds: [], updatedBy: "s" })).rejects.toMatchObject({ status: 400, reason: "strategy_empty" });
    await expect(proposeStrategyEdit({ id: "nope", excludesTacticIds: ["catch-all"], updatedBy: "s" })).rejects.toMatchObject({ status: 404, reason: "strategy_not_found" });
  });

  it("its own description and rule are never a conflict with itself", async () => {
    const r = await proposeStrategyEdit({ id: "valid-only", description: "Only confirmed", updatedBy: "s" });
    expect(r.changed).toBe(true);
  });
});
