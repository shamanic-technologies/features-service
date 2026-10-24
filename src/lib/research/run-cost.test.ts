import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/index.js", () => ({ db: {}, sql: {} }));
import { runCostOf, tokensText, unavailableRunCost } from "./run-cost.js";
import { splitCompletionCost } from "../generation-completion-costs.js";

const run = (createdAt: string, inputCents: number | null, outputCents: number | null, tokens: [number, number] | null = [1000, 200]) => ({
  createdAt,
  model: "gemini-3.8-flash",
  inputCents,
  outputCents,
  tokensInput: tokens?.[0] ?? null,
  tokensOutput: tokens?.[1] ?? null,
});

describe("runCostOf (MODEL-RUN-COST-1024)", () => {
  it("averages the priced runs, splits input/output, and the curve's last point IS the average", () => {
    const c = runCostOf([run("2026-10-01T10:00:00Z", 1, 3), run("2026-10-01T12:00:00Z", 2, 2), run("2026-10-03T09:00:00Z", 3, 1, [3000, 100])]);
    expect(c.runs).toBe(3);
    expect(c.totalUsd).toBeCloseTo(0.12);
    expect(c.averageUsd).toBeCloseTo(0.04);
    expect(c.averageInputUsd! + c.averageOutputUsd!).toBeCloseTo(c.averageUsd!);
    expect(c.averageUsd! * c.runs).toBeCloseTo(c.totalUsd);
    expect(c.history).toEqual([
      { day: "2026-10-01", runs: 2, averageUsd: 0.04 },
      { day: "2026-10-03", runs: 3, averageUsd: expect.closeTo(0.04, 10) },
    ]);
    expect(c.history.at(-1)!.averageUsd).toBeCloseTo(c.averageUsd!);
    expect(c.averageInputTokens).toBeCloseTo(5000 / 3);
    expect(c.unavailableReason).toBeNull();
  });

  it("an unknown cost is counted apart, never as $0", () => {
    const c = runCostOf([run("2026-10-01T10:00:00Z", 2, 2), run("2026-10-02T10:00:00Z", null, null)]);
    expect(c.runs).toBe(1);
    expect(c.runsWithoutCost).toBe(1);
    expect(c.averageUsd).toBeCloseTo(0.04);
  });

  it("no run = null figures with a reason", () => {
    expect(runCostOf([]).unavailableReason).toBe("no_run_on_pipe");
    expect(runCostOf([run("2026-10-01T10:00:00Z", null, null)])).toMatchObject({ averageUsd: null, unavailableReason: "no_run_cost_known" });
    expect(unavailableRunCost("not_on_vendor_basis")).toMatchObject({ averageUsd: null, runs: 0, unavailableReason: "not_on_vendor_basis" });
  });

  it("prints tokens", () => {
    expect(tokensText(12345, 210)).toBe("12,345 in / 210 out");
    expect(tokensText(null, 210)).toBeNull();
  });
});

describe("splitCompletionCost", () => {
  it("output = output-token lines; input = the rest (cache folded); cancelled rows out; parts add up exactly", () => {
    const s = splitCompletionCost([
      { costName: "openai-gpt-6-sol-tokens-input", status: "actual", totalCostInUsdCents: "3.6421739130" },
      { costName: "openai-gpt-6-sol-tokens-cached-input", status: "actual", totalCostInUsdCents: "0.0744857143" },
      { costName: "openai-gpt-6-sol-tokens-output", status: "actual", totalCostInUsdCents: "0.4077391304" },
      { costName: "openai-gpt-6-sol-tokens-output", status: "cancelled", totalCostInUsdCents: "16.0000000000" },
    ]);
    expect(s).toEqual({ inputCents: "3.7166596273", outputCents: "0.4077391304", held: false });
  });

  it("an open hold marks the run held", () => {
    expect(splitCompletionCost([{ costName: "x-tokens-output", status: "provisioned", totalCostInUsdCents: "1" }]).held).toBe(true);
  });
});

describe("rowOfSequence keeps the completion fields (MODEL-RUN-COST-1024)", async () => {
  vi.mock("../workflow-leg-assignments.js", () => ({ listLegAssignments: async () => [] }));
  vi.mock("../fleet-cell-store.js", () => ({ loadFleetCell: async () => null, storeFleetCell: async () => {} }));
  const { rowOfSequence } = await import("../generation-sequences-copy.js");
  const base = { generationId: "g1", orgId: "o", campaignId: "c", leadId: "l", model: "m", promptType: null, workflowSlug: null, createdAt: "2026-10-24T00:00:00Z", firstEmail: null };
  it("copies run ids and tokens; a reason only when no run is stated", () => {
    expect(rowOfSequence({ ...base, completionRunIds: ["r1"], completionRunsReason: null, tokensInput: 10, tokensOutput: 2 })).toMatchObject({ completionRunIds: ["r1"], completionUnknownReason: null, tokensInput: 10, tokensOutput: 2 });
    expect(rowOfSequence({ ...base, completionRunIds: null, completionRunsReason: "ambiguous" })).toMatchObject({ completionRunIds: null, completionUnknownReason: "ambiguous", tokensInput: null });
    expect(rowOfSequence(base)).toMatchObject({ completionRunIds: null, completionUnknownReason: null });
  });
});
