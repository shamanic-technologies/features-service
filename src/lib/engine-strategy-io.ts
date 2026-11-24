/**
 * IO of a campaign's strategy per Engine (MIGRATE-1105 S6; rules in `engine-strategy.ts`, PURE).
 *
 * `engineStrategyOfCampaign` is the ONE read every pick goes through (the Engine runner's scripts, the writer pick, the
 * workflow pick of an Engine still run by a workflow): the stored verdict for (campaign, Engine), re-judged by Jev when
 * the campaign's brief moved, stored again. `legacy` = the campaign holds no verdict on this Engine yet (only until the
 * S6 migration carried every live campaign; then a campaign born without one is judged on its first read).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignEngineStrategies, campaignEngineStrategyChanges } from "../db/schema.js";
import { loadChannelCatalogue } from "./channel-declarations-store.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchCampaignPipe } from "./fleet-leg-campaigns.js";
import { pipeLegKeyOf } from "./funnel-legs.js";
import { ENGINE_STRATEGY_SUPPORT, type PlatformSupport } from "./platform-caller.js";
import { loadPlayCatalogue } from "./plays-store.js";
import type { Strategy } from "./plays.js";
import { fetchSalesFunnelCampaigns } from "./sales-funnel-campaigns-client.js";
import { readRunnableScripts } from "./script-catalogue-client.js";
import { briefAsksOfCampaign } from "./brief-opt-in-io.js";
import {
  briefHashOf,
  engineStrategyBearsQuestion,
  engineStrategyPick,
  engineStrategyNeed,
  engineStrategyOptions,
  engineStrategyQuestion,
  engineStrategyState,
  optionsSignatureOf,
  strategyOfStored,
  type EngineStrategyOption,
  type EngineStrategySource,
  type StoredEngineStrategy,
} from "./engine-strategy.js";

const HELD_MS = 60_000;
const JEV_TIMEOUT_MS = 60_000;

const rowOf = (r: typeof campaignEngineStrategies.$inferSelect): StoredEngineStrategy => ({
  campaignId: r.campaignId,
  outcome: r.outcome,
  orgId: r.orgId,
  strategyId: r.strategyId,
  source: r.source as EngineStrategySource,
  briefHash: r.briefHash,
  optionsSignature: r.optionsSignature,
  confidence: r.confidence,
  model: r.model,
  carriedFrom: r.carriedFrom,
  judgedAt: r.judgedAt.toISOString(),
});

export async function readEngineStrategy(campaignId: string, outcome: string): Promise<StoredEngineStrategy | null> {
  const [r] = await db.select().from(campaignEngineStrategies).where(and(eq(campaignEngineStrategies.campaignId, campaignId), eq(campaignEngineStrategies.outcome, outcome)));
  return r ? rowOf(r) : null;
}

export async function listEngineStrategies(campaignId: string | null): Promise<StoredEngineStrategy[]> {
  const q = db.select().from(campaignEngineStrategies);
  const rows = campaignId ? await q.where(eq(campaignEngineStrategies.campaignId, campaignId)).orderBy(asc(campaignEngineStrategies.outcome)) : await q.orderBy(asc(campaignEngineStrategies.campaignId), asc(campaignEngineStrategies.outcome));
  return rows.map(rowOf);
}

export async function writeEngineStrategy(row: Omit<StoredEngineStrategy, "judgedAt">): Promise<void> {
  const values = { ...row, judgedAt: new Date() };
  // CAMPAIGN-CHANGE-LOG-1119: the kept strategy moving is appended to its history (read before, write, append).
  const before = await readEngineStrategy(row.campaignId, row.outcome);
  await db
    .insert(campaignEngineStrategies)
    .values(values)
    .onConflictDoUpdate({ target: [campaignEngineStrategies.campaignId, campaignEngineStrategies.outcome], set: values });
  const change = strategyChangeOf(before, row);
  if (change) await db.insert(campaignEngineStrategyChanges).values({ ...change, changedAt: values.judgedAt });
  forgetEngineStrategy(row.campaignId, row.outcome);
}

/** PURE. The history row a write appends: only when the kept strategy MOVES (first judgement naming none = no row). */
export function strategyChangeOf(before: { strategyId: string | null } | null, after: Omit<StoredEngineStrategy, "judgedAt">) {
  const from = before?.strategyId ?? null;
  if (from === after.strategyId) return null;
  return { campaignId: after.campaignId, outcome: after.outcome, orgId: after.orgId, fromStrategyId: from, toStrategyId: after.strategyId, source: after.source, confidence: after.confidence, model: after.model };
}

/** Every recorded change of the strategies kept for these unit campaigns, oldest first. */
export async function listEngineStrategyChanges(campaignIds: readonly string[]) {
  if (campaignIds.length === 0) return [];
  const rows = await db
    .select()
    .from(campaignEngineStrategyChanges)
    .where(inArray(campaignEngineStrategyChanges.campaignId, [...campaignIds]))
    .orderBy(asc(campaignEngineStrategyChanges.changedAt), asc(campaignEngineStrategyChanges.id));
  return rows.map((r) => ({ ...r, changedAt: r.changedAt.toISOString() }));
}

// ── The Engine a campaign unit runs (its pipe's outcome, read off the catalogue, never parsed) ──────────────────────

let catalogueHeld: { at: number; value: Promise<Awaited<ReturnType<typeof loadChannelCatalogue>>> } | null = null;
function heldCatalogue() {
  if (catalogueHeld && Date.now() - catalogueHeld.at < HELD_MS) return catalogueHeld.value;
  const value = loadChannelCatalogue({ publishedOnly: false });
  catalogueHeld = { at: Date.now(), value };
  value.catch(() => {
    if (catalogueHeld?.value === value) catalogueHeld = null;
  });
  return value;
}

/** The Engine a (channel, leg) unit runs: the outcome the catalogue names on it, else the step it reaches; null = unknown. */
export async function engineOutcomeOfPipe(featureSlug: string, legKey: string): Promise<{ outcome: string; label: string } | null> {
  const { channels } = await heldCatalogue();
  const ch = channels.find((c) => c.slug === featureSlug);
  const want = pipeLegKeyOf(featureSlug, legKey);
  const t = ch?.stepTransitions.find((x) => pipeLegKeyOf(featureSlug, x.legKey) === want);
  if (!t) return null;
  return t.outcome ? { outcome: t.outcome, label: labelOfOutcome(t.outcome) } : { outcome: t.to.key, label: t.to.label };
}

/** "email_sent" -> "Email sent". */
export const labelOfOutcome = (outcome: string): string => {
  const s = outcome.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// ── The one read ─────────────────────────────────────────────────────────────────────────────────────────────────

export type CampaignEngineStrategy =
  | { kind: "legacy" }
  | {
      kind: "kept";
      row: StoredEngineStrategy;
      strategy: Strategy | null;
      /** The opt-in script tactics the campaign's BRIEF asks for on this Engine (tactic ids; `lib/brief-opt-in.ts`). */
      briefAsks: string[];
    };

const held = new Map<string, { at: number; value: Promise<CampaignEngineStrategy> }>();
const keyOf = (campaignId: string, outcome: string) => `${campaignId}|${outcome}`;
export function forgetEngineStrategy(campaignId: string, outcome: string): void {
  held.delete(keyOf(campaignId, outcome));
}
export function __resetEngineStrategyForTest(): void {
  held.clear();
  catalogueHeld = null;
}

interface JevPick {
  option: EngineStrategyOption;
  confidence: number;
  model: string;
}

/**
 * The brief judge. `support` = whose work the call is (PLATFORM-CALLER-RUN-1024): the live judge's by default; a staff
 * dry replay states its own (`platform-caller.test.ts` pins every caller passing one).
 */
export async function askJev(state: Record<string, unknown>, options: readonly EngineStrategyOption[], support: PlatformSupport = ENGINE_STRATEGY_SUPPORT): Promise<JevPick> {
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(
    `${base}/internal/platform-judgments`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey }, body: JSON.stringify({ state, questions: { bears: engineStrategyBearsQuestion(), strategy: engineStrategyQuestion(options) }, support }) },
    { timeoutMs: JEV_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; choice?: unknown; confidence?: unknown; noul?: unknown }> };
  const a = body.answers?.strategy;
  const bears = body.answers?.bears;
  if (bears?.type !== "noul" || typeof bears.noul !== "number") throw new Error("chat-service answered without a readable bears probability");
  if (a?.type !== "choice" || typeof a.choice !== "string" || typeof a.confidence !== "number") throw new Error("chat-service answered without a readable choice");
  const index = Number(a.choice.slice(1));
  const option = a.choice.startsWith("o") && Number.isInteger(index) ? options[index] : undefined;
  if (!option) throw new Error(`chat-service picked ${a.choice}, not one of the strategies offered`);
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  return { ...engineStrategyPick(options, bears.noul, { option, confidence: a.confidence }), model: body.model };
}

/**
 * The strategy one campaign keeps on one Engine. `campaign` = the campaign a person runs (its id, org, brand). Throws when
 * the brief, the catalogue or Jev cannot be read: the caller fails closed (runs nothing, retries). No brief = no condition.
 */
export function engineStrategyOfCampaign(campaign: { campaignId: string; orgId: string; brandId: string }, engine: { outcome: string; label?: string }): Promise<CampaignEngineStrategy> {
  const key = keyOf(campaign.campaignId, engine.outcome);
  const hit = held.get(key);
  if (hit && Date.now() - hit.at < HELD_MS) return hit.value;
  const value = (async (): Promise<CampaignEngineStrategy> => {
    const stored = await readEngineStrategy(campaign.campaignId, engine.outcome);
    const rows = await fetchSalesFunnelCampaigns(campaign.brandId, null, { orgId: campaign.orgId });
    const row = rows.find((r) => r.id === campaign.campaignId);
    if (!row) throw new Error(`campaign-service lists no campaign ${campaign.campaignId} for brand ${campaign.brandId}`);
    const brief = row.brief ?? null;
    const briefHash = briefHashOf(brief);
    const catalogue = await loadPlayCatalogue();
    const label = engine.label ?? labelOfOutcome(engine.outcome);
    let scripts: Awaited<ReturnType<typeof readRunnableScripts>> = [];
    let scriptsRead = false;
    const scriptsNow = async () => {
      if (!scriptsRead) {
        scripts = await readRunnableScripts();
        scriptsRead = true;
      }
      return scripts;
    };
    // PLAN-RECURSIVE-PER-ENGINE-1124-SOURCES: the opt-in script tactics the brief asks for on this Engine, judged in this
    // same pass (stored answers, the stale ones re-asked of Jev). Before the options: an option is what it runs WITH them.
    // A failure throws like the strategy judge's. No opt-in tactic on the Engine, or no brief = no call.
    const briefAsks = await briefAsksOfCampaign(campaign, { outcome: engine.outcome, label }, brief, briefHash, catalogue, scriptsNow);
    const asked = new Set(briefAsks);
    // Options are read only when a judged verdict may have gone stale on them (a carried one stands on its brief alone).
    let options: EngineStrategyOption[] | null = null;
    const optionsNow = async () => {
      if (!options) options = engineStrategyOptions(engine.outcome, await scriptsNow(), catalogue, stored?.strategyId ? [stored.strategyId] : [], asked);
      return options;
    };
    const signature = stored?.source === "judge" && stored.briefHash === briefHash ? optionsSignatureOf(await optionsNow()) : null;
    const need = engineStrategyNeed(stored, briefHash, signature);
    if (need === "stored") return { kind: "kept", row: stored!, strategy: strategyOfStored(stored!, catalogue.strategies), briefAsks };
    if (need === "no_condition") {
      // No brief: no strategy, no filter. Every runnable script of the Engine, the Rating picks (NO-BRIEF-UNBLOCK-1111).
      const next = { campaignId: campaign.campaignId, outcome: engine.outcome, orgId: campaign.orgId, strategyId: null, source: "empty_brief" as const, briefHash: null, optionsSignature: null, confidence: null, model: null, carriedFrom: null };
      await writeEngineStrategy(next);
      console.log(`[features-service] campaign ${campaign.campaignId} states no brief: no condition on ${engine.outcome}`);
      return { kind: "kept", row: { ...next, judgedAt: new Date().toISOString() }, strategy: null, briefAsks };
    }
    const opts = await optionsNow();
    const pick = opts.length <= 1 ? { option: opts[0]!, confidence: 1, model: "single_option" } : await askJev(engineStrategyState(brief!, { outcome: engine.outcome, label }, { scripts, options: opts, c: catalogue, briefAsks: asked }), opts);
    const next = {
      campaignId: campaign.campaignId,
      outcome: engine.outcome,
      orgId: campaign.orgId,
      strategyId: pick.option.strategyId,
      source: "judge" as const,
      briefHash,
      optionsSignature: optionsSignatureOf(opts),
      confidence: pick.confidence,
      model: pick.model,
      carriedFrom: stored?.carriedFrom ?? null,
    };
    await writeEngineStrategy(next);
    console.log(`[features-service] brief of campaign ${campaign.campaignId} judged on Engine ${engine.outcome}: ${pick.option.strategyId ?? "no condition"} (${pick.confidence}, was ${stored ? (stored.strategyId ?? "no condition") : "none"})`);
    return { kind: "kept", row: { ...next, judgedAt: new Date().toISOString() }, strategy: strategyOfStored(next, catalogue.strategies), briefAsks };
  })();
  held.set(key, { at: Date.now(), value });
  value.catch(() => {
    if (held.get(key)?.value === value) held.delete(key);
  });
  return value;
}

/**
 * The strategy a campaign UNIT's Engine runs on (a unit = one row of campaign-service's `campaigns`, the shape every
 * caller still names). `legacy` when the unit names no campaign or no Engine the catalogue knows.
 */
export async function engineStrategyOfUnit(unitCampaignId: string, outcome?: string): Promise<CampaignEngineStrategy & { outcome?: string }> {
  const unit = await fetchCampaignPipe(unitCampaignId);
  if (!unit.found) return { kind: "legacy" };
  // A caller may name the campaign itself (no unit): campaign-service lists it under its own id then.
  const campaignId = unit.salesFunnelCampaignId ?? null;
  if (!campaignId || !unit.orgId || !unit.brandId) return { kind: "legacy" };
  const engine = outcome
    ? { outcome, label: labelOfOutcome(outcome) }
    : unit.featureSlug && unit.legKey
      ? await engineOutcomeOfPipe(unit.featureSlug, unit.legKey)
      : null;
  if (!engine) return { kind: "legacy" };
  return { ...(await engineStrategyOfCampaign({ campaignId, orgId: unit.orgId, brandId: unit.brandId }, engine)), outcome: engine.outcome };
}
