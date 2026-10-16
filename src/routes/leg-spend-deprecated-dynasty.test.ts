/**
 * LEG-SPEND-MISSING-1016. The conversation-leg ranking served lithium, ballad, permafrost, arcadia, tectonic... at
 * $0 spent and 0 positive replies, while runs-service held their spend on the leg's own campaigns (lithium $2.2k)
 * and the people they contacted replied. Cause: the leg roll-up seeded dynasties from versions whose status is
 * `active`, so a dynasty with EVERY version deprecated had no head and its evidence fell out of every figure.
 * Now each version's evidence counts under its own `workflowDynastySlug`; and such a dynasty, which no run can
 * pick, never sets the leg's price.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/workflow-leg-assignments.js", async (orig) => ({
  ...(await orig<typeof import("../lib/workflow-leg-assignments.js")>()),
  fetchLegAssignments: vi.fn(async () => new Map()),
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({ default: { setupExpressErrorHandler: vi.fn() }, setupExpressErrorHandler: vi.fn() }));

process.env.WORKFLOW_SERVICE_URL = "http://workflow:3000";
process.env.WORKFLOW_SERVICE_API_KEY = "workflow-key";
process.env.NODE_ENV = "test";

const { computeFleetLegWorkflowMaturity, excludedFromLegPrice } = await import("./public.js");
const legFleet = await import("../lib/leg-fleet-evidence.js");
const fleetRepliers = await import("../lib/fleet-positive-repliers.js");

const FEATURE = "sales-cold-email-outreach";
const LEG = "start_to_conversation";
const CUTOFF = (await import("../lib/maturity.js")).legCutoffIso(LEG)!;

function wf(slug: string, dynasty: string, status: "active" | "deprecated", upgradedTo: string | null = null): Record<string, unknown> {
  return { id: `id-${slug}`, workflowSlug: slug, workflowName: slug, workflowDynastyName: dynasty, workflowDynastySlug: dynasty, version: 1, status, workflowDynastyStatus: status, featureSlug: FEATURE, createdForBrandId: null, upgradedTo };
}
// lithium: both versions deprecated (v1 upgraded to v2, v2 then deprecated). azalea: deprecated v1 -> active v2.
const WORKFLOWS = [
  wf("lithium", "lithium", "deprecated", "id-lithium-v2"),
  wf("lithium-v2", "lithium", "deprecated"),
  wf("azalea", "azalea", "deprecated", "id-azalea-v2"),
  wf("azalea-v2", "azalea", "active"),
];
const group = (slug: string, cents: string) => ({ dimensions: { workflowSlug: slug }, totalCostInUsdCents: cents, runCount: 3, minStartedAt: null, maxStartedAt: null });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("a dynasty whose every version is deprecated keeps its real figures on the leg", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://workflow:3000/public/workflows")) return json({ workflows: WORKFLOWS });
      return new Response("{}", { status: 404 });
    });
    vi.mocked(legFleet.fetchLegFleetEvidence).mockResolvedValue({
      campaigns: [{ campaignId: "c1", orgId: "o1", brandId: "b1" }],
      costGroups: [group("lithium", "150000"), group("lithium-v2", "70000"), group("azalea", "30000"), group("azalea-v2", "20000")] as never,
      emailStats: new Map([
        ["lithium", { recipientsContacted: 9000, recipientsClicked: 0, recipientsRepliesPositive: 0 }],
        ["lithium-v2", { recipientsContacted: 2600, recipientsClicked: 0, recipientsRepliesPositive: 0 }],
        ["azalea", { recipientsContacted: 2000, recipientsClicked: 0, recipientsRepliesPositive: 0 }],
        ["azalea-v2", { recipientsContacted: 1600, recipientsClicked: 0, recipientsRepliesPositive: 0 }],
      ]),
    });
    vi.mocked(fleetRepliers.fetchFleetPositiveRepliesBySlug).mockResolvedValue(new Map([["lithium", 15], ["lithium-v2", 6], ["azalea", 4], ["azalea-v2", 3]]));
    vi.mocked(legFleet.fetchLegFleetMatureEvidence).mockResolvedValue({
      cutoffIso: CUTOFF,
      costGroups: [group("lithium", "150000"), group("azalea", "30000")] as never,
      emailStats: new Map([
        ["lithium", { recipientsContacted: 9000, recipientsClicked: 0, recipientsRepliesPositive: 15 }],
        ["azalea", { recipientsContacted: 2000, recipientsClicked: 0, recipientsRepliesPositive: 4 }],
      ]),
    });
  });

  it("states lithium's spend, contacted and positive replies, flash and mature, on the same basis as azalea", async () => {
    const m = await computeFleetLegWorkflowMaturity(FEATURE, LEG);
    const by = new Map(m.byDynasty);
    expect(by.get("lithium")!.flash).toMatchObject({ spentUsd: 2200, contacted: 11600, outcomes: 21 });
    expect(by.get("lithium")!.mature).toMatchObject({ spentUsd: 1500, outcomes: 15, costPerOutcomeUsd: 100 });
    expect(by.get("azalea")!.flash).toMatchObject({ spentUsd: 500, contacted: 3600, outcomes: 7 });
    // Every cent of the leg is in a dynasty: the fleet total reconciles with the cost groups'.
    const flashTotal = [...by.values()].reduce((a, f) => a + (f.flash?.spentUsd ?? 0), 0);
    expect(flashTotal).toBeCloseTo(2700, 9);
  });

  it("never lets a dynasty no run can pick set the leg's price", async () => {
    const excluded = await excludedFromLegPrice(FEATURE, LEG);
    expect(excluded.has("lithium")).toBe(true);
    expect(excluded.has("azalea")).toBe(false);
  });
});
