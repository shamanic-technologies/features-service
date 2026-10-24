import { afterEach, describe, expect, it, vi } from "vitest";

vi.unmock("./ledger-leg-overlay.js");
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("./channel-declarations-store.js", () => ({ loadChannelCatalogue: vi.fn(async () => ({ channels: [] })) }));
vi.mock("./fleet-leg-campaigns.js", () => ({ fetchFleetCampaignRows: vi.fn(async () => []) }));
const { overlayLegEvidence, ledgerOutcomeOfLeg, ledgerBasisOf, withLedgerFlash, __resetLedgerInputs } = await import("./ledger-leg-overlay.js");
import type { LedgerInputs } from "./ledger-leg-overlay.js";
import type { CostGroup } from "./public-stats-clients.js";

const group = (slug: string, cents: string): CostGroup => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: cents, netTotalCostInUsdCents: cents, runCount: 3, minStartedAt: null, maxStartedAt: "2026-10-20T00:00:00Z" });

// fleet: $120 of sends by two workflows on the reply pipe, $2 of judging off any campaign, 20 replies
const ledger: LedgerInputs = {
  totals: {
    produced: [
      { outcomeKey: "message_sent", campaignId: "c1", orgId: "o1", produced: 2000, ownCostUsd: 120 },
      { outcomeKey: "conversation", campaignId: null, orgId: "o1", produced: 20, ownCostUsd: 2 },
    ],
    consumed: [],
    coveragePct: 99,
    supportUsd: 0,
    supportByFunction: [],
    supportDaysMissing: 0,
    daysMissing: 0,
    coverageByOrg: new Map(),
  },
  byWorkflow: {
    produced: [
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "keel-v2", ownCostUsd: 100 },
      { outcomeKey: "message_sent", campaignId: "c1", workflowSlug: "ballad-v4", ownCostUsd: 20 },
      { outcomeKey: "message_sent", campaignId: "c9", workflowSlug: "off-leg", ownCostUsd: 7 },
    ],
    sourced: [
      { consumerKey: "conversation", consumedKey: "message_sent", sourceWorkflowSlug: "keel-v2", count: 5 },
      { consumerKey: "conversation", consumedKey: "message_sent", sourceWorkflowSlug: "ballad-v4", count: 10 },
    ],
    daysMissing: 0,
  },
  outputOf: (c) => (c === "c1" || c === "c9" ? "conversation" : null),
  pipeOutputs: new Set(["conversation"]),
};

describe("the leg ranking reads the ledger (COST-ACCOUNTING-1023-SWITCH)", () => {
  afterEach(() => __resetLedgerInputs());

  it("each version's spend and positive replies come from the ledger: cost per reply = its unit production cost", () => {
    const costGroups = [group("keel-v2", "4000"), group("ballad-v4", "1500"), group("never-on-ledger", "900")];
    const emailStats = new Map([["keel-v2", { recipientsContacted: 900, recipientsRepliesPositive: 3 }], ["ballad-v4", { recipientsContacted: 400, recipientsRepliesPositive: 9 }]]);
    const o = overlayLegEvidence(costGroups, emailStats, "conversation", new Set(["c1"]), ledger);
    const cents = (s: string) => Number(o.costGroups.find((g) => g.dimensions.workflowSlug === s)!.totalCostInUsdCents);
    // shared stage = 122/20 - 120/20 = $0.10 per reply; keel = 5 x ($20 + $0.10)
    expect(cents("keel-v2")).toBeCloseTo(5 * (100 / 5 + 0.1) * 100, 6);
    expect(cents("ballad-v4")).toBeCloseTo(10 * (20 / 10 + 0.1) * 100, 6);
    expect(o.emailStats.get("keel-v2")).toMatchObject({ recipientsContacted: 900, recipientsRepliesPositive: 5 });
    expect(o.emailStats.get("ballad-v4")!.recipientsRepliesPositive).toBe(10);
    // a version the ledger does not know keeps its runs figure; production outside the leg's campaigns counts for nothing
    expect(cents("never-on-ledger")).toBe(900);
    expect(o.costGroups.some((g) => g.dimensions.workflowSlug === "off-leg")).toBe(false);
    expect(o.rebased.sort()).toEqual(["ballad-v4", "keel-v2"]);
    // the shared cached inputs are never touched
    expect(costGroups[0]!.totalCostInUsdCents).toBe("4000");
    expect(emailStats.get("keel-v2")!.recipientsRepliesPositive).toBe(3);
  });

  it("a version that spent on the leg with no reply reads its own production as spend, 0 replies", () => {
    const l = { ...ledger, byWorkflow: { ...ledger.byWorkflow, sourced: ledger.byWorkflow.sourced.filter((s) => s.sourceWorkflowSlug !== "keel-v2") } };
    const o = overlayLegEvidence([group("keel-v2", "1")], new Map(), "conversation", new Set(["c1"]), l);
    expect(Number(o.costGroups[0]!.totalCostInUsdCents)).toBeCloseTo(10000, 6);
    expect(o.emailStats.get("keel-v2")!.recipientsRepliesPositive).toBe(0);
  });

  it("only the positive reply leg moves today; vendorUnpriced stays on runs", () => {
    expect(ledgerOutcomeOfLeg("start_to_conversation")).toBe("conversation");
    expect(ledgerOutcomeOfLeg("start_to_website_visit")).toBeNull();
    expect(ledgerOutcomeOfLeg("conversation_to_meeting_booked")).toBeNull();
    expect(ledgerBasisOf("net")).toBe("net");
    expect(ledgerBasisOf("vendorUnpriced" as never)).toBeNull();
  });

  it("an unreadable ledger keeps the runs evidence, never a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const flash = { costGroups: [group("keel-v2", "4000")], emailStats: new Map([["keel-v2", { recipientsRepliesPositive: 3 }]]) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await withLedgerFlash("t", "start_to_conversation", "gross", flash, new Set(["c1"]))).toBe(flash);
    expect(err).toHaveBeenCalled();
    vi.unstubAllGlobals();
    err.mockRestore();
  });
});
