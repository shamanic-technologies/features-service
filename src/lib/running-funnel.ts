import type { SalesFunnelCampaignRow } from "./sales-funnel-campaigns-client.js";

/** "Running" = the funnel the campaign RUNS: campaign-service's `runningSalesFunnelId` (a campaign following its plan
 *  runs the plan's funnel), else the funnel it was born on (older campaign-service). Read by the factory shadow and by
 *  the Campaigns rows' `path` (P5.1). */
export const runningFunnelIdOf = (r: Pick<SalesFunnelCampaignRow, "salesFunnelId" | "runningSalesFunnelId">): string => r.runningSalesFunnelId ?? r.salesFunnelId;
