import { describe, expect, it } from "vitest";
import { rankWriters, type WriterCandidate } from "./leg-writer-ranking.js";

const c = (key: string, basis: "mature" | "flash", spentUsd: number, outcomes: number, selectable = true): WriterCandidate => ({
  key,
  label: key,
  selectable,
  notSelectableReason: selectable ? null : "no_dynasty_on_pipe",
  basis,
  figures: { spentUsd, contacted: outcomes * 100 + 50, outcomes },
});

describe("leg writer ranking (BEST-TPL-LLM-1022): the workflows' leg order on $/outcome", () => {
  it("worked example: Gemini 3 Flash mature at $43, Claude Opus 5.5 new at $12 spent and 0 replies: Opus goes first", () => {
    const r = rankWriters([c("gemini-3-flash", "mature", 430, 10), c("claude-opus-5.5", "flash", 12, 0)]);
    expect(r.rows.map((x) => [x.key, x.place])).toEqual([
      ["claude-opus-5.5", "explore"],
      ["gemini-3-flash", "money"],
    ]);
    expect(r.best?.key).toBe("claude-opus-5.5");
    expect(r.rows[0]!.explorePriceUsd).toBe(12);
    expect(r.rows[0]!.costPerOutcomeUsd).toBeNull();
    expect(r.rows[1]!.costPerOutcomeUsd).toBe(43);
    expect(r.rows[1]!.moneyGoesHere).toBe(true);
  });

  it("once Opus spent past $43 without an outcome, the best mature one goes first again", () => {
    const r = rankWriters([c("gemini-3-flash", "mature", 430, 10), c("claude-opus-5.5", "flash", 44, 0)]);
    expect(r.rows.map((x) => [x.key, x.place])).toEqual([
      ["gemini-3-flash", "money"],
      ["claude-opus-5.5", "proven_worse"],
    ]);
  });

  it("a template created this morning ($0 spent) goes first: never floored up to the best mature price", () => {
    const r = rankWriters([c("blind-angle", "mature", 430, 10), c("offer-angle", "flash", 12, 0), c("new-template", "flash", 0, 0)]);
    expect(r.rows.map((x) => x.key)).toEqual(["new-template", "offer-angle", "blind-angle"]);
    expect(r.rows[0]!.explorePriceUsd).toBe(0);
    expect(r.best?.key).toBe("new-template");
  });

  it("a learning item with outcomes is priced on spend ÷ outcomes against the best mature price", () => {
    const r = rankWriters([c("a", "mature", 430, 10), c("b", "flash", 60, 2), c("c", "flash", 100, 2)]);
    expect(r.rows.map((x) => [x.key, x.place])).toEqual([
      ["b", "explore"],
      ["a", "money"],
      ["c", "proven_worse"],
    ]);
  });

  it("a strategy whose tactics exclude an item never returns it", () => {
    const r = rankWriters([c("gemini-3-flash", "mature", 430, 10), c("claude-opus-5.5", "flash", 0, 0)], (key) => (key === "claude-opus-5.5" ? "the strategy excludes it" : null));
    expect(r.rows.map((x) => x.key)).toEqual(["gemini-3-flash"]);
    expect(r.best?.key).toBe("gemini-3-flash");
    expect(r.excluded).toEqual([{ key: "claude-opus-5.5", label: "claude-opus-5.5", reason: "the strategy excludes it" }]);
  });

  it("a candidate a run may not write with ranks after every selectable one and is never the pick", () => {
    const r = rankWriters([c("standalone-v3", "flash", 0, 0, false), c("dynasty", "mature", 50, 5)]);
    expect(r.rows.map((x) => [x.key, x.place])).toEqual([
      ["dynasty", "money"],
      ["standalone-v3", "cannot_run"],
    ]);
    expect(rankWriters([c("standalone-v3", "flash", 0, 0, false)]).best).toBeNull();
  });
});
