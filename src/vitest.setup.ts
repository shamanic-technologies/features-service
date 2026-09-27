/**
 * Suite-wide default: the FLEET positive-repliers read (lib/fleet-positive-repliers.ts) walks every
 * brand's lead population through lead-service's feature memberships, which no route fixture answers.
 * It resolves to `undefined` here, so a route suite keeps email-gateway's fleet reply counts exactly as
 * its fixture states them. Suites that assert the fleet basis `vi.unmock` it (or set their own return).
 */
import { vi } from "vitest";

vi.mock("./lib/fleet-positive-repliers.js", () => ({
  fetchFleetPositiveRepliesBySlug: vi.fn(async () => undefined),
  warmFleetPositiveRepliers: vi.fn(async () => undefined),
  __resetFleetPositiveRepliers: vi.fn(),
}));

/**
 * Suite-wide default: the LEG's fleet population (lib/leg-fleet-evidence.ts) reads campaign-service's
 * whole campaign list, which no route fixture answers. It resolves to `undefined` here, so a leg-keyed
 * route suite keeps the leg-less evidence its fixture states. Suites asserting the leg scope `vi.unmock` it.
 */
vi.mock("./lib/leg-fleet-evidence.js", () => ({
  fetchLegFleetEvidence: vi.fn(async () => undefined),
  __resetLegFleetEvidence: vi.fn(),
  mergeCostGroupsBySlug: vi.fn(),
  mergeEmailStats: vi.fn(),
}));
