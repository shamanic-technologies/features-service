import { describe, expect, it } from "vitest";
import { computeFleetIndexPoints, engagedLeadPoint, type BrandEngagement } from "./fleet-indexes.js";
import { vendorLegPrice, vendorPooled, vendorRankingRows, type PipeVendorTwin } from "./fleet-index-vendor.js";
import type { LegWorkflowRankingRow } from "./leg-workflow-ranking.js";
import { legMaturityFigures, outcomeFigures } from "./maturity.js";
import type { LegPrice } from "./outcome-prices.js";
import { vendorCoverage } from "./public-vendor-cost.js";

function row(over: Partial<LegWorkflowRankingRow>): LegWorkflowRankingRow {
  return {
    rank: 1,
    workflowDynastySlug: "rampart",
    workflowDynastyName: "Rampart",
    assignment: "active",
    executable: true,
    selectable: true,
    isMature: true,
    basis: "mature",
    costPerOutcomeUsd: 4,
    conversionRatePct: 2,
    outcomes: 15,
    contacted: 720,
    spentUsd: 60,
    roiMultiple: null,
    pipelineUsd: null,
    billedSpendUsd: null,
    goesFirst: true,
    moneyGoesHere: true,
    explorePriceUsd: null,
    place: "money",
    ...over,
  };
}

/** A dynasty's spend on both halves (counts do not matter to the twin). */
const spend = (flashUsd: number, matureUsd: number) => legMaturityFigures("start_to_conversation", outcomeFigures(flashUsd, 0, 0), outcomeFigures(matureUsd, 0, 0));

const byslug = (points: ReturnType<typeof computeFleetIndexPoints>) => new Map(points.map((p) => [p.indexSlug, p]));

describe("public vendor cost (PUBLIC-VENDOR-COST-1031)", () => {
  it("serves a vendor figure only while the unpriced billed share is within 1%", () => {
    expect(vendorCoverage(20, 1, 100)).toMatchObject({ unpricedSharePct: 1, servable: true });
    expect(vendorCoverage(20, 1.01, 100)).toMatchObject({ servable: false });
    expect(vendorCoverage(0, 0, 0)).toMatchObject({ unpricedSharePct: 0, servable: true });
  });

  it("an index keeps the BILLED pick and divides the same outcomes by the pick's vendor spend", () => {
    const billed = [
      row({ workflowDynastySlug: "learning", basis: "flash", isMature: false, moneyGoesHere: false, costPerOutcomeUsd: 0.1, outcomes: 2, spentUsd: 0.2 }),
      row({ workflowDynastySlug: "rampart", costPerOutcomeUsd: 4, outcomes: 15, spentUsd: 60 }),
    ];
    // On the vendor basis "learning" would look even cheaper: it is still not the money row.
    const twin: PipeVendorTwin = {
      vendor: new Map([["rampart", spend(80, 15)], ["learning", spend(0.01, 0)]]),
      unpriced: new Map([["rampart", spend(0, 0.3)]]),
    };
    const rows = vendorRankingRows(billed, twin);
    expect(rows.map((r) => r.workflowDynastySlug)).toEqual(["learning", "rampart"]);
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: rows, meetingPipe: null }));
    // Mature half: $15 vendor / 15 positive replies = $1 (was $4 billed); 0.3 of 60 unpriced = 0.5%, within tolerance.
    expect(p.get("cold-email-cost-per-positive-reply")).toMatchObject({ value: 1, workflowDynastySlug: "rampart", outcomes: 15 });
    expect(p.get("cold-email-cost-per-positive-reply")!.inputs).toMatchObject({ spentUsd: 15, unpricedSharePct: 0.5 });
    // A rate reads no money: unchanged.
    expect(p.get("cold-email-positive-reply-rate")).toMatchObject({ value: 2 });
  });

  it("a pick whose vendor cost is not known reads null + vendor_cost_unknown, never the billed figure", () => {
    const rows = vendorRankingRows([row({ spentUsd: 60 })], { vendor: new Map([["rampart", spend(80, 15)]]), unpriced: new Map([["rampart", spend(0, 6)]]) });
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: rows, positiveReplyRows: null, meetingPipe: null }));
    expect(p.get("cold-email-cost-per-click")).toMatchObject({ value: null, unavailableReason: "vendor_cost_unknown" });
    expect(p.get("cold-email-click-rate")).toMatchObject({ value: 2, unavailableReason: null });
  });

  it("a vendor half the twin does not state is unknown, never $0", () => {
    const rows = vendorRankingRows([row({})], { vendor: new Map(), unpriced: new Map() });
    expect(rows[0]).toMatchObject({ costPerOutcomeUsd: null, vendorCostUnknown: true });
  });

  it("the meeting cost chain reads both pipes at vendor cost; an unknown meeting pick withholds it", () => {
    const reply = vendorRankingRows([row({ spentUsd: 60 })], { vendor: new Map([["rampart", spend(80, 15)]]), unpriced: new Map() });
    const mbRow = row({ workflowDynastySlug: "rhodium", outcomes: 5, contacted: 10, spentUsd: 50, costPerOutcomeUsd: 10 });
    const meetingRows = vendorRankingRows([mbRow], { vendor: new Map([["rhodium", spend(10, 10)]]), unpriced: new Map() });
    const pooled = vendorPooled({ spentUsd: 50, contacted: 10, outcomes: 5, spentByDynasty: { rhodium: 50 } }, { rhodium: 10 }, {});
    const p = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: reply, meetingPipe: { rows: meetingRows, pooled } }));
    // $1 per reply / 50% booking + $10 / 5 meetings = $2 + $2.
    expect(p.get("cold-email-cost-per-meeting")!.value).toBeCloseTo(4, 10);
    const unknown = vendorRankingRows([mbRow], { vendor: new Map([["rhodium", spend(10, 10)]]), unpriced: new Map([["rhodium", spend(5, 5)]]) });
    const q = byslug(computeFleetIndexPoints({ websiteVisitRows: null, positiveReplyRows: reply, meetingPipe: { rows: unknown, pooled } }));
    expect(q.get("cold-email-cost-per-meeting")).toMatchObject({ value: null, unavailableReason: "vendor_cost_unknown" });
    expect(q.get("cold-email-meeting-rate")!.value).toBeCloseTo(1, 10);
  });

  it("an outcome price leg keeps its pick and its outcomes, its cost on vendor spend", () => {
    const leg: LegPrice = {
      legKey: "start_to_conversation",
      featureSlug: "sales-cold-email-outreach",
      basis: "mature",
      workflowDynastySlug: "rampart",
      costPerOutcomeUsd: 4,
      conversionRatePct: 2,
      figures: outcomeFigures(60, 750, 15),
      matureWorkflowCount: 1,
      unmeasuredReason: null,
    };
    expect(vendorLegPrice(leg, { vendor: new Map([["rampart", spend(80, 15)]]), unpriced: new Map() })).toMatchObject({ costPerOutcomeUsd: 1, vendorCostUnknown: false, workflowDynastySlug: "rampart" });
    expect(vendorLegPrice(leg, { vendor: new Map([["rampart", spend(80, 15)]]), unpriced: new Map([["rampart", spend(9, 9)]]) })).toMatchObject({ costPerOutcomeUsd: null, vendorCostUnknown: true });
  });

  it("the engaged-lead median runs over the clients whose vendor cost is known, the others counted", () => {
    const b = (spendCents: number, unknown: boolean): BrandEngagement => ({ contacted: 100, positiveReplies: 2, screenedContacted: 0, humanClicks: 0, spendCents, vendorCostUnknown: unknown });
    expect(engagedLeadPoint([b(1000, false), b(3000, false)])).toMatchObject({ value: 10 });
    const p = engagedLeadPoint([b(1000, false), b(3000, false), b(9000, true)]);
    expect(p).toMatchObject({ value: 10, outcomes: 2 });
    expect(p.inputs).toMatchObject({ clients: 2, clientsVendorCostUnknown: 1 });
  });
});
