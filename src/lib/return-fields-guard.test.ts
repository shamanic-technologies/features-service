import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ROI-CONSISTENCY-1103 (owner 2026-11-03, industrial cost accounting): a RETURN exists only where a
// value lands. Three returns are allowed: a campaign's EXPECTED return (its Target's value over the cost
// to make one from Start), a campaign's MEASURED return and a brand's / offer's REALIZED return (Paid
// clients our outreach caused over money actually spent). Below a Target (pipe, workflow, step,
// channel, audience, outcome) a figure is a cost per Unit, a cost from Start or a conversion rate,
// never a return; a pipeline in dollars is a forecast, never a return's numerator.
//
// This guard fails when the served contract grows a return-like field outside an allowed return. The
// LEGACY list of fields served before the rule is EMPTY since ROI-CONSISTENCY-1103-DELETE (2026-11-03):
// every pipeline-based ROI, %CAC, $CAC, pipe / workflow / step / channel / audience / outcome return and
// public return median was deleted. Never add a name back.

// `returns` = the period recap block holding exactly the expected + realized returns. A field INSIDE an
// allowed return (its `roiMultiple`, its basis...) is that return's own field, never a second return.
const ALLOWED = new Set(["ExpectedReturn", "expectedReturn", "realizedReturn", "returns"]);

// Return-LIKE names that are not a return below a Target, each kept only WHERE it is served today:
// a sales funnel's / sales path's expected return per paying client (its Target = Paid client), the
// factory plan line's return on its Target, the Deals board's labelled pipeline forecast, and the
// dashboard visit frequency (a "return" visit, no money).
const KEPT: Record<string, ReadonlySet<string>> = {
  dashboardReturnFrequency: new Set(["#CustomerHealthResponse"]),
  expectedPipelineUsd: new Set(["#OfferDealsLifecycleResponse"]),
  roi: new Set([
    "#FactoryShadowPlan",
    "#LivedSalesPaths",
    "#OfferSalesPathsResponse",
    "/internal/catalogue/sales-funnels",
    "/internal/catalogue/sales-funnels/{id}",
    "/internal/catalogue/sales-paths",
    "/internal/catalogue/sales-paths/{id}",
    "/internal/factory-shadow/monitoring",
    "/public/catalogue/sales-funnels",
  ]),
  roiBasis: new Set([
    "#LivedSalesPaths",
    "/internal/catalogue/sales-funnels",
    "/internal/catalogue/sales-funnels/{id}",
    "/internal/catalogue/sales-paths",
    "/internal/catalogue/sales-paths/{id}",
    "/public/catalogue/sales-funnels",
  ]),
  roiUnavailableReason: new Set(["#OfferSalesPathsResponse"]),
};

const RETURN_LIKE = /(roi|return(perdollar)?|pipelineusd|costofacquisitionpct|costperacquisitionusd|valueadded)/i;
const SCHEMA_WORDS = new Set(["description", "properties", "required", "type", "items", "allOf", "anyOf", "oneOf", "$ref", "enum"]);

/** Every return-like key outside an allowed return, as `key @ location` (location = `#Component` or a path). */
function unexpectedReturnKeys(node: unknown, where: string, out: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const x of node) unexpectedReturnKeys(x, where, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (ALLOWED.has(k)) continue;
      if (!SCHEMA_WORDS.has(k) && RETURN_LIKE.test(k) && !KEPT[k]?.has(where)) out.add(`${k} @ ${where}`);
      unexpectedReturnKeys(v, where, out);
    }
  }
  return out;
}

function unexpectedInDoc(doc: { paths?: Record<string, unknown>; components?: { schemas?: Record<string, unknown> } }): string[] {
  const out = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    if (RETURN_LIKE.test(path)) out.add(`path ${path}`);
    unexpectedReturnKeys(ops, path, out);
  }
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    if (ALLOWED.has(name)) continue;
    if (RETURN_LIKE.test(name)) out.add(`component ${name}`);
    unexpectedReturnKeys(schema, `#${name}`, out);
  }
  return [...out].sort();
}

describe("served returns follow industrial cost accounting (ROI-CONSISTENCY-1103)", () => {
  it("serves no return-like field beyond the allowed returns and the kept non-returns, each where it is", () => {
    const doc = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"));
    expect(unexpectedInDoc(doc)).toEqual([]);
  });

  it("refuses a field that would be a return below a Target", () => {
    const doc = { components: { schemas: { PipeRow: { properties: { pipeRoiMultiple: {} } } } } };
    expect(unexpectedInDoc(doc)).toEqual(["pipeRoiMultiple @ #PipeRow"]);
  });

  it("refuses a kept name served somewhere new (a pipe row's roi)", () => {
    const doc = { paths: { "/internal/catalogue/pipes": { get: { properties: { roi: {} } } } } };
    expect(unexpectedInDoc(doc)).toEqual(["roi @ /internal/catalogue/pipes"]);
  });

  it("reads a field inside an allowed return as that return's own", () => {
    const doc = { components: { schemas: { OfferRevenue: { properties: { realizedReturn: { properties: { roiMultiple: {} } } } } } } };
    expect(unexpectedInDoc(doc)).toEqual([]);
  });
});
