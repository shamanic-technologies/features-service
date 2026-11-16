import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { legDefaultConversionPct } from "./public.js";

describe("leg workflow ranking", () => {
  it("states the leg's seeded conversion for an entry leg", () => {
    expect(legDefaultConversionPct("start_to_conversation")).toBe(1);
    expect(legDefaultConversionPct("start_to_website_visit")).toBe(2);
  });
});
