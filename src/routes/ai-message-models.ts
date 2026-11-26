/**
 * GET /internal/stats/ai-message-models[?days=] — the stored daily series of messages our runs sent with vs without
 * the model that actually wrote them named (MODEL-TAG-EVERY-AI-MESSAGE-1126; pure `lib/ai-message-models.ts`, built
 * hourly off the request path by `lib/ai-message-models-io.ts`). Fleet + per org. Staff-gated at api-service
 * (`/v1/features/audit/ai-message-models`). Dashboard v2 Monitoring charts « AI messages with no model named »:
 * `health.broken` only when today's or yesterday's sends hold one (red only when broken), or the series stopped.
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { AI_MESSAGE_MODELS_RULE, fleetOf } from "../lib/ai-message-models.js";
import { readStoredAiMessageModelDays } from "../lib/ai-message-models-io.js";
import { readModelIds } from "../lib/model-ids-client.js";
import { vendorOf } from "../lib/written-by.js";
import { answerInternalError } from "../lib/internal-error.js";

const router = Router();

/** The series is rebuilt hourly; past this age it stopped, which is broken too. */
const STALE_AFTER_MS = 3 * 60 * 60_000;

export const AI_MESSAGE_MODELS_RULE_TEXT =
  "An AI message = a message_sent Unit one of our runs declared in the ledger (every channel) whose sending run consumed a message_written Unit " +
  "(a send that consumed none, a newsletter release, is counted apart). Its model = the LLM billed in the run that wrote the " +
  "message_written Unit the send consumed (the one billed last), read off chat-service's cost names: the model that actually ran, never the one " +
  "a script asks for. A message with no model names why.";

router.get("/internal/stats/ai-message-models", apiKeyOnly, async (req, res) => {
  const raw = req.query.days;
  const days = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) return void res.status(400).json({ error: "days must be an integer 1..90", reason: "days_unrecognised" });
  try {
    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await readStoredAiMessageModelDays(since);
    const byDay = new Map<string, typeof rows>();
    for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
    const series = [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, orgRows]) => ({
        day,
        computedAt: orgRows.map((r) => r.computedAt).sort().at(-1) as string,
        fleet: fleetOf(orgRows),
        orgs: orgRows.filter((r) => r.messages + r.sentNotWrittenByOurRuns > 0).map(({ day: _d, computedAt: _c, ...o }) => o),
      }));
    const models = await readModelIds().catch((error) => {
      console.error("[features-service] ai-message-models: chat-service model names unreadable this time:", error);
      return null;
    });
    const modelIds = [...new Set(series.flatMap((d) => Object.keys(d.fleet.byModel)))].sort();
    const modelNames = Object.fromEntries(
      modelIds.map((id) => {
        const m = models?.find((x) => x.modelId === id);
        return [id, m ? { name: m.displayName, vendor: vendorOf(m.provider) } : null];
      }),
    );
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const recent = series.filter((d) => d.day === today || d.day === yesterday);
    const unnamedRecent = recent.reduce((a, d) => a + d.fleet.withoutModel, 0);
    const lastComputedAt = series.map((d) => d.computedAt).sort().at(-1) ?? null;
    const stale = lastComputedAt === null || Date.now() - Date.parse(lastComputedAt) > STALE_AFTER_MS;
    res.json({
      rule: AI_MESSAGE_MODELS_RULE,
      ruleText: AI_MESSAGE_MODELS_RULE_TEXT,
      days: series,
      modelNames,
      health: {
        broken: unnamedRecent > 0 || stale,
        unnamedOnRecentSends: unnamedRecent,
        lastComputedAt,
        reason: stale ? "series_not_rebuilt" : unnamedRecent > 0 ? "ai_messages_with_no_model_named" : null,
      },
    });
  } catch (error) {
    console.error("[features-service] ai-message-models read failed:", error);
    answerInternalError(res, error);
  }
});

export default router;
