/**
 * Suite-wide default: the FLEET positive-repliers read (lib/fleet-positive-repliers.ts) walks every
 * brand's lead population through lead-service's feature memberships, which no route fixture answers.
 * It resolves to `undefined` here, so a route suite keeps email-gateway's fleet reply counts exactly as
 * its fixture states them. Suites that assert the fleet basis `vi.unmock` it (or set their own return).
 */
import { vi } from "vitest";

vi.mock("./lib/fleet-positive-repliers.js", () => ({
  fetchFleetPositiveRepliesBySlug: vi.fn(async () => undefined),
  fetchFleetMatureSlugStats: vi.fn(async () => undefined),
  fetchFleetContactedBySlug: vi.fn(async () => undefined),
  bucketPopulation: vi.fn(),
  warmFleetPositiveRepliers: vi.fn(async () => undefined),
  __resetFleetPositiveRepliers: vi.fn(),
}));

/**
 * Suite-wide default: the stored fleet cell (lib/fleet-cell-store.ts) is a Postgres row. Here nothing is
 * stored, every build claim is granted and a store is a no-op — each process builds its own cell, the
 * behaviour before the store existed. `fleet-positive-repliers.test.ts` swaps in an in-memory store.
 */
vi.mock("./lib/fleet-cell-store.js", () => ({
  loadFleetCell: vi.fn(async () => null),
  claimFleetCellBuild: vi.fn(async () => true),
  storeFleetCell: vi.fn(async () => undefined),
}));

/**
 * Suite-wide default: the LEG's fleet population (lib/leg-fleet-evidence.ts) reads campaign-service's
 * whole campaign list, which no route fixture answers. It resolves to `undefined` here, so a leg-keyed
 * route suite keeps the leg-less evidence its fixture states. Suites asserting the leg scope `vi.unmock` it.
 */
vi.mock("./lib/leg-fleet-evidence.js", () => ({
  fetchLegFleetEvidence: vi.fn(async () => undefined),
  fetchLegFleetMatureEvidence: vi.fn(async () => undefined),
  __resetLegFleetEvidence: vi.fn(),
  mergeCostGroupsBySlug: vi.fn(),
  mergeEmailStats: vi.fn(),
  mergeMatureCostGroups: vi.fn(),
}));

/**
 * Suite-wide default: the fleet median of stated offer lifetime revenues (lib/effective-conversion-rates.ts)
 * sweeps every brand through lead-service's feature memberships, which no route fixture answers. Null here
 * (no offer in the fleet states one), so a fixture's unstated offer stays unpriced as it states. Suites
 * asserting the fleet-median default set their own return.
 */
vi.mock("./lib/effective-conversion-rates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/effective-conversion-rates.js")>()),
  getFleetLifetimeRevenueMedian: vi.fn(async () => ({ usd: null, offerCount: 0 })),
}));

/**
 * Suite-wide default: which (channel, leg) is an INTERNAL pipe (lib/pipe-kind.ts) is read off the channel
 * catalogue (a DB read no route fixture answers). Null here: every leg read keeps the walk of its basis
 * funnel, as before the one-rule change. Suites asserting the internal-pipe measure `vi.unmock` it or set
 * their own return.
 */
vi.mock("./lib/pipe-kind.js", () => ({
  internalPipeToStep: vi.fn(async () => null),
  __resetPipeKind: vi.fn(),
}));

/**
 * Suite-wide default: a sales funnel PIPE's spend attribution (lib/pipe-spend-attribution-io.ts) reads
 * campaign-service's funnel campaigns, which no route fixture answers. It resolves to `null` (nothing moves)
 * here, so a campaign-scoped suite keeps the spend its fixture states. `routes/pipe-spend-attribution.test.ts`
 * `vi.unmock`s it.
 */
vi.mock("./lib/pipe-spend-attribution-io.js", () => ({
  resolvePipeSpendAttribution: vi.fn(async () => null),
}));

/**
 * Suite-wide default: the EXPECTED return's per-offer model (lib/expected-return.ts) runs the offer's whole sales
 * paths read (campaign-service, brand-service, every leg ladder), which no route fixture answers. The IO entry
 * points resolve to a named unavailable figure here; the pure pickers stay real. `lib/expected-return.test.ts`
 * tests them directly; a suite asserting the wire field sets its own return.
 */
vi.mock("./lib/expected-return.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/expected-return.js")>();
  const unavailable = async () => actual.unavailableExpectedReturn("expected_model_unavailable");
  return {
    ...actual,
    expectedReturnForOffer: vi.fn(unavailable),
    expectedReturnForFunnelCampaign: vi.fn(unavailable),
    expectedReturnForCampaign: vi.fn(unavailable),
    expectedReturnForBrand: vi.fn(unavailable),
    expectedReturnForScope: vi.fn(unavailable),
  };
});

/**
 * Suite-wide default: tactics, strategies, plays and Jev verdicts (lib/plays-store.ts) are Postgres rows no route
 * fixture holds. The empty catalogue here = no pipe catalogues a play, so every read is byte-unchanged (the pipe runs
 * every assigned workflow, as before plays). Suites asserting plays set their own return; the sweep never runs.
 */
vi.mock("./lib/plays-store.js", async () => {
  const { buildPlayCatalogue } = await import("./lib/plays.js");
  return {
    loadPlayCatalogue: vi.fn(async () => buildPlayCatalogue({ tactics: [], strategies: [], plays: [], verdicts: [] })),
    invalidatePlayCatalogue: vi.fn(),
    listVerdicts: vi.fn(async () => []),
    insertTactic: vi.fn(),
    updateTacticDescription: vi.fn(),
    insertStrategy: vi.fn(),
    proposeStrategyEdit: vi.fn(),
    storeStrategyEdit: vi.fn(),
    insertPlay: vi.fn(),
    insertVerdict: vi.fn(async () => undefined),
    refreshVersionActive: vi.fn(async () => undefined),
  };
});
vi.mock("./lib/tactic-judgments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/tactic-judgments.js")>()),
  kickTacticJudgments: vi.fn(async () => ({ versions: 0, judged: 0, failed: 0, alreadyJudged: 0 })),
  startTacticJudgmentLoop: vi.fn(),
}));

/**
 * Suite-wide default: lead-service's Disqualified MARK list (lib/disqualification-marks.ts) is a
 * lead-service read no route fixture answers. Nobody is marked here, so every fixture prices as it
 * states. Suites asserting the mark set their own return (or `vi.unmock` it to test the client).
 */
vi.mock("./lib/disqualification-marks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/disqualification-marks.js")>()),
  fetchDisqualifiedLeadIds: vi.fn(async () => new Set<string>()),
}));
