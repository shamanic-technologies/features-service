/**
 * IO of what a campaign's brief asks for (PLAN-RECURSIVE-PER-ENGINE-1124-SOURCES; rules in `brief-opt-in.ts`, PURE).
 *
 * `askBriefOptIns` is the ONE Jev call: one `noul` question per opt-in tactic, in one request. `briefAsksOfCampaign` is
 * the live pass (called by `engineStrategyOfCampaign` only, the read that already may ask Jev): stored answers, the stale
 * ones re-asked and stored. Every other reader takes the STORED answers (`brief-opt-in-store.ts`) and never asks.
 * A failure throws: the caller fails closed like the strategy judge (never a silent "not asked").
 */
import { fetchWithRetry } from "./fetch-retry.js";
import { BRIEF_OPT_IN_SUPPORT, type PlatformSupport } from "./platform-caller.js";
import { optInTacticsOnEngine, subjectOfTactic, type PlayCatalogue, type Tactic } from "./plays.js";
import type { RunnableScript } from "./script-catalogue-client.js";
import { BRIEF_ASKS_FROM, askedByBrief, briefAsksQuestions, briefAsksState, briefAsksToJudge, type StoredBriefAsk } from "./brief-opt-in.js";
import { readBriefAsks, writeBriefAsks } from "./brief-opt-in-store.js";

const JEV_TIMEOUT_MS = 60_000;

export interface BriefAskAnswer {
  tacticId: string;
  asks: boolean;
  probability: number;
  model: string;
}

/**
 * Jev: does the brief ask for each of these opt-in tactics on this Engine? `support` = whose work the call is
 * (PLATFORM-CALLER-RUN-1024): the live judge's by default; a staff dry replay states its own (`platform-caller.test.ts`).
 */
export async function askBriefOptIns(state: Record<string, unknown>, tactics: readonly Tactic[], support: PlatformSupport = BRIEF_OPT_IN_SUPPORT): Promise<BriefAskAnswer[]> {
  if (tactics.length === 0) return [];
  const base = process.env.CHAT_SERVICE_URL;
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!base || !apiKey) throw new Error("[features-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY not configured");
  const res = await fetchWithRetry(
    `${base}/internal/platform-judgments`,
    { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey }, body: JSON.stringify({ state, questions: briefAsksQuestions(tactics), support }) },
    { timeoutMs: JEV_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`chat-service platform-judgments ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> };
  if (typeof body.model !== "string" || body.model === "") throw new Error("chat-service answered without naming the model release");
  const model = body.model;
  return tactics.map((t, i) => {
    const a = body.answers?.[`t${i}`];
    if (a?.type !== "noul" || typeof a.noul !== "number") throw new Error(`chat-service answered without a readable probability on whether the brief asks for "${t.name}"`);
    return { tacticId: t.id, asks: a.noul >= BRIEF_ASKS_FROM, probability: a.noul, model };
  });
}

/** PURE: does the catalogue hold any opt-in script tactic at all (none = nothing to read, byte-identical to before). */
export const holdsOptInScriptTactic = (c: Pick<PlayCatalogue, "tactics">): boolean => [...c.tactics.values()].some((t) => t.optIn === true && subjectOfTactic(t) === "script");

/**
 * The LIVE pass: the opt-in tactics this campaign's brief asks for on one Engine (tactic ids). Stored answers stand while
 * the brief and the tactic's description are unchanged; the others are asked of Jev in one call and stored. No brief = no
 * call (stored answers stand). No opt-in tactic applying on the Engine = no read at all.
 */
export async function briefAsksOfCampaign(
  campaign: { campaignId: string; orgId: string },
  engine: { outcome: string; label: string },
  brief: string | null,
  briefHash: string | null,
  catalogue: Pick<PlayCatalogue, "tactics" | "tacticsByWriter">,
  scriptsNow: () => Promise<readonly RunnableScript[]>,
): Promise<string[]> {
  if (!holdsOptInScriptTactic(catalogue)) return [];
  const scripts = await scriptsNow();
  const own = scripts.filter((s) => s.outcome === engine.outcome);
  if (own.length === 0) return [];
  const optIns = optInTacticsOnEngine(own, catalogue.tactics);
  if (optIns.length === 0) return [];
  const stored = await readBriefAsks(campaign.campaignId, engine.outcome);
  const toJudge = briefAsksToJudge(optIns, stored, briefHash);
  if (toJudge.length === 0) return askedByBrief(stored, engine.outcome, optIns);
  const answers = await askBriefOptIns(briefAsksState(brief!, engine, toJudge, scripts, catalogue), toJudge);
  const descriptionOf = new Map(toJudge.map((t) => [t.id, t.description]));
  const fresh: Omit<StoredBriefAsk, "judgedAt">[] = answers.map((a) => ({
    campaignId: campaign.campaignId,
    outcome: engine.outcome,
    tacticId: a.tacticId,
    orgId: campaign.orgId,
    asks: a.asks,
    probability: a.probability,
    model: a.model,
    briefHash: briefHash!,
    judgedDescription: descriptionOf.get(a.tacticId)!,
  }));
  await writeBriefAsks(fresh);
  const judged = new Set(fresh.map((r) => r.tacticId));
  const now = [...stored.filter((r) => !judged.has(r.tacticId)), ...fresh];
  const asked = askedByBrief(now, engine.outcome, optIns);
  console.log(`[features-service] brief of campaign ${campaign.campaignId} asked on ${toJudge.length} opt-in tactic(s) of Engine ${engine.outcome}: asks for ${asked.length ? asked.join(", ") : "none"}`);
  return asked;
}
