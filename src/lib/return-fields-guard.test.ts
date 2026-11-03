import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ROI-CONSISTENCY-1103 (owner 2026-11-03, industrial cost accounting): a RETURN exists only where a
// value lands. Three returns are allowed: a campaign's EXPECTED return (its Target's value over the cost
// to make one from Start), a campaign's MEASURED return and a brand's / offer's REALIZED return (Paid
// clients our outreach caused over money actually spent). Below a Target (pipe, workflow, step,
// channel, audience, outcome) a figure is a cost per Unit, a cost from Start or a conversion rate,
// never a return; a pipeline in dollars is a forecast, never a return's numerator.
//
// This guard fails when the served contract grows a return-like field that is neither allowed nor on
// the LEGACY list below. The LEGACY list holds every field served before the rule: they are retired once
// no screen reads them anymore (consumers first, then this list shrinks). Never add a name to LEGACY.

// `returns` = the period recap block holding exactly the expected + realized returns.
const ALLOWED = new Set(["ExpectedReturn", "expectedReturn", "realizedReturn", "returns"]);

const LEGACY = new Set([
  "/internal/stats/workflow-return-history/actual-cost",
  "/public/stats/funnel-return-on-spend",
  "/public/stats/outcome-return-on-spend",
  "/public/stats/return-on-spend",
  "/public/stats/workflow-return-history",
  "MatureScopesReturn",
  "costOfAcquisitionPct",
  "costPerAcquisitionUsd",
  "cumulativePipelineUsd",
  "dashboardReturnFrequency",
  "datedPipelineUsd",
  "expectedPipelineUsd",
  "flashRoiMultiple",
  "headlinePipelineUsd",
  "highestReturn",
  "matureRoiMultiple",
  "maxReturnPerDollar",
  "medianReturnPerDollar",
  "minReturnPerDollar",
  "noRowPipelineUsd",
  "p25ReturnPerDollar",
  "p75ReturnPerDollar",
  "pipelineUsd",
  "returnHalf",
  "returnPathLegKeys",
  "returnPerDollar",
  "returnPerDollarMaturity",
  "returnScopes",
  "roi",
  "roiBasis",
  "roiCombinationKey",
  "roiDetail",
  "roiHealthy",
  "roiHistory",
  "roiMultiple",
  "roiUnavailableReason",
  "totalPipelineUsd",
  "undatedPipelineUsd",
  "valueAdded",
  "valueAddedUsd",
]);

const RETURN_LIKE = /(roi|return(perdollar)?|pipelineusd|costofacquisitionpct|costperacquisitionusd|valueadded)/i;
const SCHEMA_WORDS = new Set(["description", "properties", "required", "type", "items", "allOf", "anyOf", "oneOf", "$ref", "enum"]);

function returnLikeKeys(node: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const x of node) returnLikeKeys(x, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (!SCHEMA_WORDS.has(k) && RETURN_LIKE.test(k)) out.add(k);
      returnLikeKeys(v, out);
    }
  }
  return out;
}

describe("served returns follow industrial cost accounting (ROI-CONSISTENCY-1103)", () => {
  it("serves no return-like field beyond the allowed returns and the legacy ones being retired", () => {
    const doc = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"));
    const unexpected = [...returnLikeKeys(doc, new Set())].filter((k) => !ALLOWED.has(k) && !LEGACY.has(k));
    expect(unexpected).toEqual([]);
  });

  it("refuses a field that would be a return below a Target", () => {
    const keys = returnLikeKeys({ components: { schemas: { PipeRow: { properties: { pipeRoiMultiple: {} } } } } }, new Set());
    expect([...keys].filter((k) => !ALLOWED.has(k) && !LEGACY.has(k))).toEqual(["pipeRoiMultiple"]);
  });
});
