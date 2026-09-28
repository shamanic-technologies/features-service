import { describe, expect, it } from "vitest";
import { buildMatureScopesReturn, combineVerdicts, overMatureScopes, type MaturityReturnRow } from "./fleet-return-maturity.js";

/**
 * ONE population where the medians over EVERY brand and over MATURE brands only disagree: the two young
 * brands read the extreme returns (a lucky 40x and an unlucky 0.1x) that a young cohort produces, so a
 * median taken over them — or over flash — moves; the one served does not.
 */
function row(over: Partial<MaturityReturnRow> & { mature: number; flash: number; isMature?: boolean | null }): MaturityReturnRow {
  return {
    committedSpendUsd: 200,
    expectedPipelineUsd: 200 * over.mature,
    flashCommittedSpendUsd: 300,
    flashExpectedPipelineUsd: 300 * over.flash,
    isMature: over.isMature,
    ...over,
  };
}

const ROWS: MaturityReturnRow[] = [
  row({ mature: 2, flash: 1.5, isMature: true }),
  row({ mature: 3, flash: 2.5, isMature: true }),
  row({ mature: 4, flash: 3, isMature: true }),
  row({ mature: 40, flash: 20, isMature: false }), // young and lucky
  row({ mature: 0.1, flash: 0.2, isMature: false }), // young and unlucky
  row({ mature: 5, flash: 4, isMature: null }), // could not be cut — never counted as mature
];

describe("buildMatureScopesReturn — the fleet median over MATURE scopes only, on both versions", () => {
  it("takes the median over the mature brands alone, on both versions", () => {
    const out = buildMatureScopesReturn(ROWS, 100, 3);
    expect(out).toMatchObject({ basis: "mature_scopes", measured: true, reason: null, brandCount: 3 });
    expect(out.mature!.median).toBeCloseTo(3, 9);
    expect(out.flash!.median).toBeCloseTo(2.5, 9);
    expect(out.mature!.max).toBeCloseTo(4, 9); // the young 40x is not in it
    expect(out.mature!.min).toBeCloseTo(2, 9); // nor the young 0.1x
  });

  it("the spend floor applies to the MATURE spend, as the legacy median's does", () => {
    const thin = [...ROWS.slice(0, 2), row({ mature: 4, flash: 3, isMature: true, committedSpendUsd: 50 })];
    expect(buildMatureScopesReturn(thin, 100, 3)).toMatchObject({ measured: false, reason: "not_enough_brands", brandCount: 2 });
  });

  it("a snapshot written before the verdict existed says so, never 'not enough brands'", () => {
    const legacy = ROWS.map(({ isMature: _v, ...rest }) => rest as MaturityReturnRow);
    expect(buildMatureScopesReturn(legacy, 100, 3)).toMatchObject({ measured: false, reason: "maturity_not_recorded_yet" });
    expect(buildMatureScopesReturn(null, 100, 3)).toMatchObject({ measured: false, reason: "no_snapshot_yet", brandCount: 0 });
  });

  it("a leg-keyed read passes its own verdict", () => {
    const out = buildMatureScopesReturn(ROWS, 100, 1, (r) => (r.isMature === false ? true : false));
    expect(out.brandCount).toBe(2);
    expect(out.mature!.max).toBeCloseTo(40, 9);
  });
});

describe("combineVerdicts — a young part is a young whole", () => {
  it("any false wins; any unknown otherwise; all true is true; nothing recorded stays undefined", () => {
    expect(combineVerdicts([true, false, null])).toBe(false);
    expect(combineVerdicts([true, null])).toBeNull();
    expect(combineVerdicts([true, true])).toBe(true);
    expect(combineVerdicts([undefined, undefined])).toBeUndefined();
    expect(combineVerdicts([])).toBeUndefined();
  });
});

describe("overMatureScopes — a legacy median is fed MATURE brands only", () => {
  const rows = [{ v: true, x: 1 }, { v: false, x: 2 }, { v: null, x: 3 }, { v: true, x: 4 }];
  const build = (pop: readonly { x: number }[] | null) => ({ reason: pop === null ? "no_snapshot_yet" : null, xs: pop?.map((r) => r.x) ?? null });
  it("keeps only the verdict-true rows; young and uncut rows are out", () => {
    expect(overMatureScopes(rows, (r) => r.v, build)).toEqual({ reason: null, xs: [1, 4] });
  });
  it("no verdict on any row is maturity_not_recorded_yet, never the unfiltered rows; null stays null", () => {
    const unrecorded = rows.map((r) => ({ ...r, v: undefined }));
    expect(overMatureScopes(unrecorded, (r) => r.v, build)).toEqual({ reason: "maturity_not_recorded_yet", xs: [] });
    expect(overMatureScopes(null as typeof rows | null, (r) => r.v, build)).toEqual({ reason: "no_snapshot_yet", xs: null });
  });
});
