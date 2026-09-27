import { describe, it, expect, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { canonicalRequest, diffPaths } = await import("./view-keeper.js");

describe("canonicalRequest", () => {
  it("sorts the query so two spellings compare equal", () => {
    expect(canonicalRequest("/a?b=2&a=1")).toBe(canonicalRequest("/a?a=1&b=2"));
  });
});

describe("diffPaths", () => {
  it("is empty for equal values whatever the key order", () => {
    expect(diffPaths({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toEqual([]);
  });
  it("names every differing path", () => {
    expect(diffPaths({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3, 4] })).toEqual(["$.a", "$.b.length(2!=3)", "$.b[1]"]);
  });
});
