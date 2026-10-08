import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { applyConversionFromRowAbove, type ExclusiveContactedRow, type ExclusiveLadderRow } from "./offer-pipeline-explained.js";
import type { ChannelStepKey } from "./acquisition-channels.js";

const group = (count: number) => ({ count, leads: [] });
function row(key: ChannelStepKey, pricedPeople: number | null, notOurs = 0): ExclusiveLadderRow {
  return {
    step: { key, label: key },
    pricedPeople,
    valuePerOutcomeUsd: null,
    pipelineUsd: null,
    countedWithColleagueUsd: null,
    people: pricedPeople === null ? null : { limit: 25, ours: group(pricedPeople), lost: group(0), notOurs: group(notOurs) },
    hot: null,
    conversionFromRowAbove: null,
  };
}
function contacted(count: number): ExclusiveContactedRow {
  return {
    count,
    valuedCount: 0,
    expiredCount: 0,
    cannotConvertCount: 0,
    unpricedCount: 0,
    valuePerPersonUsd: null,
    pipelineUsd: null,
    countedWithColleagueUsd: null,
    explanation: null,
    people: { limit: 25, leads: [] },
    conversionFromRowAbove: null,
  };
}

describe("sliced ladder conversion = row above / (row + row above) (owner 2026-10-08)", () => {
  it("pins the owner's worked example: Meeting booked 2, Replied 8, Clicked 30, People contacted 960", () => {
    // Climbing order (shallowest first), as served; hidden rows (no people) interleaved.
    const rows = [row("website_visit", 30), row("conversation", 8), row("signup", 0), row("meeting_booked", 2), row("paid_client", 0)];
    const c = contacted(960);
    applyConversionFromRowAbove(rows, c);
    const [clicked, replied, signup, meeting, paid] = rows;
    expect(meeting!.conversionFromRowAbove).toBeNull();
    expect(paid!.conversionFromRowAbove).toBeNull();
    expect(signup!.conversionFromRowAbove).toBeNull();
    expect(replied!.conversionFromRowAbove).toMatchObject({ rowAbove: { key: "meeting_booked" }, rowAbovePeople: 2, rowPeople: 8 });
    expect(Math.round(replied!.conversionFromRowAbove!.ratePct!)).toBe(20);
    expect(clicked!.conversionFromRowAbove).toMatchObject({ rowAbove: { key: "conversation" }, rowAbovePeople: 8, rowPeople: 30 });
    expect(Math.round(clicked!.conversionFromRowAbove!.ratePct!)).toBe(21);
    expect(c.conversionFromRowAbove).toMatchObject({ rowAbove: { key: "website_visit" }, rowAbovePeople: 30, rowPeople: 960 });
    expect(Math.round(c.conversionFromRowAbove!.ratePct!)).toBe(3);
    expect(c.conversionFromRowAbove!.ratePct).toBeCloseTo((30 / 990) * 100, 10);
  });

  it("a row with only notOurs people is displayed (total 0) and stays the row above", () => {
    const rows = [row("website_visit", 5), row("conversation", 0, 3)];
    const c = contacted(0);
    applyConversionFromRowAbove(rows, c);
    expect(rows[1]!.conversionFromRowAbove).toBeNull();
    expect(rows[0]!.conversionFromRowAbove).toMatchObject({ rowAbove: { key: "conversation" }, rowAbovePeople: 0, rowPeople: 5, ratePct: 0 });
    expect(c.conversionFromRowAbove).toMatchObject({ rowAbovePeople: 5, rowPeople: 0, ratePct: 100 });
  });

  it("0 / (0 + 0) is null, never 0; no displayed step row leaves the contacted row null", () => {
    const rows = [row("website_visit", 0, 1), row("conversation", 0, 2)];
    applyConversionFromRowAbove(rows, contacted(0));
    expect(rows[0]!.conversionFromRowAbove).toMatchObject({ ratePct: null });
    const empty = contacted(10);
    applyConversionFromRowAbove([row("website_visit", null), row("conversation", 0)], empty);
    expect(empty.conversionFromRowAbove).toBeNull();
  });
});
