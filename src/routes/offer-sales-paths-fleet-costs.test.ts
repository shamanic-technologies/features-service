import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The route's fleet-cost read must AWAIT the boot build (never the sync read that answers empty while the
// first build runs, which priced measured legs at their seeded default for minutes after every deploy).
const route = readFileSync(new URL("./offer-sales-paths.ts", import.meta.url), "utf8");
const code = route.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("sales-paths fleet costs never depend on uptime", () => {
  it("awaits the outcome-prices build, never the sync empty-store read", () => {
    expect(code).toContain("await (await import(\"./public.js\")).awaitFleetLegCostsFromOutcomePrices()");
    expect(code).not.toContain("fleetLegCostsFromOutcomePrices()");
  });
  it("a store still empty past the bound is a visible 503, not a default-priced 200", () => {
    expect(code).toContain("error instanceof StoreNotComputedError");
    expect(code).toContain('reason: "fleet_costs_not_computed_yet"');
    expect(code).toContain("res.status(503)");
  });
});
