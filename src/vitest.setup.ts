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
