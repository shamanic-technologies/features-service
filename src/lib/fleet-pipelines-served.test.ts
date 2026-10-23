import { describe, expect, it } from "vitest";
import { servedFleetPipelines } from "./fleet-pipelines-served.js";

describe("servedFleetPipelines (RESEARCH-PERFORMANCE-1023)", () => {
  const complete = { pairsFailed: 0, total: 16215 };
  const partial = { pairsFailed: 1, total: 460 };
  it("a complete sum is served", () => expect(servedFleetPipelines(complete, undefined)).toBe(complete));
  it("a partial sum never replaces the last complete one", () => expect(servedFleetPipelines(partial, complete)).toBe(complete));
  it("a key never complete serves its partial sum (pairsFailed stated)", () => expect(servedFleetPipelines(partial, undefined)).toBe(partial));
  it("a newer complete sum replaces the older one", () => {
    const newer = { pairsFailed: 0, total: 17000 };
    expect(servedFleetPipelines(newer, complete)).toBe(newer);
  });
});
