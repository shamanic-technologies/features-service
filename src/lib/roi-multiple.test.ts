import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { roiMultipleOf, servedRoiMultiple } from "./roi-multiple.js";
import { accountingReturn } from "./outcome-accounting.js";
import { campaignTargetRowOf, type CampaignTargetInput } from "./campaign-targets.js";
import { expectedReturnOf, measuredReturnOf } from "./published-units.js";
import { ledgerRealizedReturn, type ScopeOutcomeLedgerRow } from "./scope-outcome-ledger.js";
import { buildCatalogueModel, funnelById, type CatalogueInputs, type PipeMeasurement } from "./agent-catalogue.js";
import { buildChannelCatalogue } from "./channel-catalogue.js";
import { SEED_FEATURES } from "../seed/features.js";
import { servedLegKeyOf } from "./funnel-legs.js";

// ROI-ROUNDING-1116: funnel campaign "Mixed Email Replies" ($10 client value) served an expected ROI of 0 where the
// true figure was ~0.004x, because every ROI was rounded to 2 decimals. A positive ROI never reads 0.
const TINY = 10 / 2500; // 0.004x

describe("ROI-ROUNDING-1116: a served ROI multiple keeps significant digits, never 2 decimals", () => {
  it("the one rule: 6 significant digits, a tiny positive ROI stays positive, float noise trimmed", () => {
    expect(roiMultipleOf(10, 2500)).toBe(0.004);
    expect(roiMultipleOf(1, 3)).toBe(0.333333);
    expect(roiMultipleOf(10, 2_013.33)).toBe(0.0049669);
    expect(roiMultipleOf(1, 1_000_000)).toBe(0.000001);
    expect(servedRoiMultiple(0.1 + 0.2)).toBe(0.3);
    expect(roiMultipleOf(4200, 100)).toBe(42);
  });

  it("outcome accounting: measured and expected returns at the Target", () => {
    const r = accountingReturn(["c1"], { targetUnits: 1, spentUsd: 2500 }, 10, 2500);
    expect(r.measured.roiMultiple).toBe(TINY);
    expect(r.expected.roiMultiple).toBe(TINY);
  });

  it("campaign Targets: the measured return", () => {
    const base: CampaignTargetInput = {
      salesFunnelCampaignId: "c1",
      name: "Mixed Email Replies",
      offerId: "o1",
      mode: "proactive",
      target: { key: "conversation", label: "Positive reply", lifecycleRung: "conversation" },
      targetDays: [{ date: "2026-11-16", cumulativeOutcomes: 1 }],
      undatedTargetCount: 1,
      spentUsd: 2500,
      spendByDay: [{ date: "2026-11-16", spendUsd: 2500 }],
      targetValueUsd: 10,
      targetValueUnavailableReason: null,
      plan: null,
      dailyBudgetUsd: 100,
      capacity: { campaignStatus: "ongoing", budget: null, volumeReached: null, unreadableReason: null },
      now: "2026-11-16T12:00:00.000Z",
    } as unknown as CampaignTargetInput;
    expect(campaignTargetRowOf(base).measuredReturn.roiMultiple).toBe(TINY);
  });

  it("published Units: the measured and expected returns", () => {
    expect(measuredReturnOf(1, 10, 2500, false).roiMultiple).toBe(TINY);
    expect(expectedReturnOf(10, { costPerUnitUsd: 2500, costSource: "pipe", basis: "measured", pipeId: "p" }, null).roiMultiple).toBe(TINY);
  });

  it("the ledger's realized return", () => {
    const paidClient = { units: 1, ourUnits: 1, unitsUnavailableReason: null } as unknown as ScopeOutcomeLedgerRow;
    expect(ledgerRealizedReturn(paidClient, 10, 2500).realizedReturn?.roiMultiple).toBe(TINY);
  });

  it("the catalogue: a funnel's ROI (economics and expected) on a $10 client value is positive, never 0", () => {
    const channels = buildChannelCatalogue(SEED_FEATURES.filter((f) => f.status === "active"));
    const mature = (costPerOutcomeUsd: number, conversionRatePct: number): PipeMeasurement => ({ basis: "mature", costPerOutcomeUsd, conversionRatePct, workflowDynastySlug: "w" });
    const inputs: CatalogueInputs = {
      channels,
      publishedPipeIds: new Set(channels.flatMap((c) => c.stepTransitions.map((t) => `${c.slug}|${servedLegKeyOf(c.slug, t.legKey)}`))),
      declaredSteps: [],
      measurements: new Map([
        ["sales-cold-email-outreach|lead_found_to_conversation", mature(40, 1)],
        ["ai-meeting-booking|conversation_to_meeting_booked", mature(2, 30)],
        ["lead-sourcing|start_to_lead_found", mature(0.5, 100)],
      ]),
      lifetimeRevenueUsd: 10,
    } as CatalogueInputs;
    const model = buildCatalogueModel(inputs);
    const f = funnelById(model, "lead_found_to_conversation@sales-cold-email-outreach+conversation_to_meeting_booked@ai-meeting-booking+meeting_booked_to_meeting_attended+meeting_attended_to_paid_client")!;
    // $2,013.33 per paying client (see agent-catalogue.test.ts) against a $10 client: ~0.005x.
    expect(f.economics.roi!).toBeGreaterThan(0);
    expect(f.economics.roi!).toBeCloseTo(10 / 2013.33, 5);
    expect(f.expected.roi!).toBeGreaterThan(0);
    expect(f.expected.roi!).toBeCloseTo(10 / f.expected.costUsd!, 5);
  });

  it("no ROI multiple in src/lib is rounded to a fixed number of decimals (the one rule, every site)", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      readFileSync(join(dir, f), "utf8").split("\n").forEach((line, i) => {
        if (/\b(roi|roiMultiple)\s*[:=][^,;]*\b(round\d*|toFixed)\(/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
