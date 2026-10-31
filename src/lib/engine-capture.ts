/**
 * WHAT ONE REVENUE ENGINE PASS PRICED, handed to a caller that asked for it (PUBLIC-VENDOR-COST-1031-HISTORY): the
 * client-median index history (`lib/client-index-history.ts`) replays a pair's pass AS OF each past day on the very
 * persons, paths and pricing the live pass used, so the as-of-today replay IS the live figure. A request that asks
 * nothing pays nothing (`captureEngineInputs` is a no-op outside `withEngineCapture`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ContactedPricing, EnginePerson, FunnelMilestone, ResolvedPath } from "./revenue-engine.js";
import type { MaturityPlan } from "./roi-maturity.js";
import type { ScopeCampaign } from "./scope-maturity.js";

export interface EngineCapture {
  paths: ResolvedPath[];
  /** The persons the engine priced (overlays applied), deduped by the engine itself. */
  persons: EnginePerson[];
  closeValueUsd: number;
  milestones: readonly FunnelMilestone[];
  contacted: ContactedPricing | null;
  plan: MaturityPlan;
  /** The scope's campaigns with their legs (the maturity verdict's input); null = unreadable. */
  campaigns: ScopeCampaign[] | null;
  /** The pass cut a mature cohort (a cutoff AND a mature spend read): else the cohort is the whole scope. */
  matureCut: boolean;
}

const sinks = new AsyncLocalStorage<(c: EngineCapture) => void>();

/** Run `fn`; every engine pass inside it hands its inputs to `sink`. */
export function withEngineCapture<T>(sink: (c: EngineCapture) => void, fn: () => Promise<T>): Promise<T> {
  return sinks.run(sink, fn);
}

/** Called by `computeFeatureRevenue` right after its priced engine pass. */
export function captureEngineInputs(c: EngineCapture): void {
  sinks.getStore()?.(c);
}
