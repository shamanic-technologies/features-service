/**
 * GET /orgs/usage — what the org (from `x-org-id`) was billed for, by customer activity. Org-wide,
 * like billing: no brand filter. The classification lives in `lib/usage-categories.ts`; this route
 * only reads runs-service and fails loud (a swallowed error would show a fake $0 bill).
 */
import { Router } from "express";
import { apiKeyAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { fetchWithRetry } from "../lib/fetch-retry.js";
import { buildUsageBreakdown } from "../lib/usage-categories.js";
import { buildScopeKey, campaignLiveTtlMs, sendSnapshotJson, servedCachedJson } from "../lib/view-cache.js";

const router = Router();

router.get("/orgs/usage", apiKeyAuth, async (rawReq, res) => {
  const req = rawReq as AuthenticatedRequest;
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    return res.status(500).json({ error: "RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not configured" });
  }
  try {
    // Served from the Gold layer (lib/view-cache.ts): runs-service's org-wide cost aggregation takes
    // 3-30s on the largest org (prod 2026-10-08), so the read serves the org's last computed body and
    // refreshes it behind the response. The cell goes stale after the campaign views' live TTL (3s, under
    // the dashboard's 5s poll), so a polled page asks runs-service exactly as often as it did before. A
    // compute failure on a miss still propagates (502 below); a failed background refresh keeps the prior
    // body and logs loud.
    const payload = await servedCachedJson({
      view: "org-usage",
      scopeKey: buildScopeKey("org-usage", { orgId: req.orgId }),
      orgId: req.orgId,
      ttlMs: campaignLiveTtlMs(),
      compute: async () => {
        const params = new URLSearchParams({ groupBy: "serviceName,taskName,campaignId" });
        const response = await fetchWithRetry(`${url}/v1/stats/costs?${params}`, {
          headers: { "x-api-key": apiKey, "x-org-id": req.orgId, "x-user-id": req.userId, "x-run-id": req.runId },
        });
        if (!response.ok) {
          throw new Error(`runs-service /v1/stats/costs failed (${response.status}): ${await response.text()}`);
        }
        const data = (await response.json()) as { groups?: unknown };
        if (!Array.isArray(data.groups)) throw new Error("runs-service /v1/stats/costs returned no groups array");
        return buildUsageBreakdown(data.groups as Parameters<typeof buildUsageBreakdown>[0]);
      },
    });
    return sendSnapshotJson(res, payload);
  } catch (error) {
    console.error(`[features-service] usage error for org ${req.orgId}:`, error);
    return res.status(502).json({ error: "Failed to compute usage" });
  }
});

export default router;
