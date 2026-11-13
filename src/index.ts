// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import * as Sentry from "@sentry/node";
import express from "express";
import { startEngineHeldMonitor } from "./lib/engine-held-monitor.js";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { warmFleetPositiveRepliers } from "./lib/fleet-positive-repliers.js";
import { warmFleetStatedMediansOnBoot } from "./lib/effective-conversion-rates.js";
import { coldEmailOutreachSlugs } from "./lib/send-forecast-compute.js";
import healthRoutes from "./routes/health.js";
import featuresRoutes from "./routes/features.js";
import statsRoutes from "./routes/stats.js";
import revenueRoutes from "./routes/revenue.js";
import workflowProjectionRoutes from "./routes/workflow-projection.js";
import pipelineActivityRoutes from "./routes/pipeline-activity.js";
import offerEconomicsRoutes from "./routes/offer-economics.js";
import offerOutcomesRoutes from "./routes/offer-outcomes.js";
import brandLeadFamiliesRoutes from "./routes/brand-lead-families.js";
import offerSourcingRoutes from "./routes/offer-sourcing.js";
import offerSalesPathsRoutes from "./routes/offer-sales-paths.js";
import usageRoutes from "./routes/usage.js";
import writtenByRoutes from "./routes/written-by.js";
import sourcingInvestmentRoutes from "./routes/sourcing-investment.js";
import brandEconomicsRoutes from "./routes/brand-economics.js";
import contactedValueRoutes from "./routes/contacted-value.js";
import dealsValueRoutes from "./routes/deals-value.js";
import brandCompaniesRoutes from "./routes/brand-companies.js";
import offerLeadValuesRoutes from "./routes/offer-lead-values.js";
import conversionRatesRoutes from "./routes/conversion-rates.js";
import rateSourcesRoutes from "./routes/rate-sources.js";
import audienceStatsRoutes from "./routes/audience-stats.js";
import publicRoutes, { warmFleetBrandSnapshotsOnBoot, warmShowcaseFunnelsOnBoot, warmOutcomePrices, warmLegWorkflowRankingOnBoot } from "./routes/public.js";
import viewCacheAdminRoutes from "./routes/view-cache-admin.js";
import workflowLegAssignmentsRoutes from "./routes/workflow-leg-assignments.js";
import channelDeclarationsRoutes from "./routes/channel-declarations.js";
import agentCatalogueRoutes, { warmCatalogueMeasurementsOnBoot } from "./routes/agent-catalogue.js";
import { scheduleBootWarms, type BootWarmStep } from "./lib/boot-warms.js";
import { startTacticJudgmentLoop } from "./lib/tactic-judgments.js";
import fleetIndexesRoutes, { startFleetIndexRecorder } from "./routes/fleet-indexes.js";
import researchRoutes, { startResearchRefreshLoop } from "./routes/research.js";
import { legWriterRankingBootPipes, warmLegWriterRankingOnBoot } from "./routes/leg-writer-ranking.js";
import scriptStrategyRoutes from "./routes/script-strategy.js";
import engineStrategyRoutes from "./routes/engine-strategies.js";
import engineLlmRatingRoutes from "./routes/engine-llm-rating.js";
import unitReportsRoutes from "./routes/unit-reports.js";
import scriptRatingRoutes from "./routes/script-rating.js";
import scriptEnginesRoutes, { startScriptEnginesLoop, warmScriptEngines } from "./routes/script-engines.js";
import { startEngineLlmEvidenceLoop, warmEngineLlmEvidence } from "./lib/engine-llm-rating-io.js";
import { startLlmCallFeed } from "./lib/llm-call-feed.js";
import customerHealthRoutes, { warmCustomerHealthOnBoot } from "./routes/customer-health.js";
import securityAdvisoriesRoutes from "./routes/security-advisories.js";
import boxHealthRoutes from "./routes/box-health.js";
import boxChecksRoutes from "./routes/box-checks.js";
import factoryShadowRoutes, { startFactoryShadowLoop } from "./routes/factory-shadow.js";
import { startOutreachFactsCopy } from "./lib/outreach-facts-copy.js";
import { startGenerationSequencesCopy } from "./lib/generation-sequences-copy.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import orgPeriodRecapRoutes from "./routes/org-period-recap.js";
import salesFunnelCampaignsRoutes from "./routes/sales-funnel-campaigns.js";
import salesFunnelCampaignActivityRoutes from "./routes/sales-funnel-campaign-activity.js";
import campaignNextStepsRoutes from "./routes/campaign-next-steps.js";
import spendChartsRoutes from "./routes/spend-charts.js";
import campaignMilestonesRoutes from "./routes/campaign-milestones.js";
import campaignTargetsRoutes from "./routes/campaign-targets.js";
import publishedUnitsRoutes from "./routes/published-units.js";
import { startBulkRunSweep } from "./lib/published-units-io.js";
import outcomeCostSeriesRoutes from "./routes/outcome-cost-series.js";
import livedSalesPathsRoutes from "./routes/lived-sales-paths.js";
import { registerChannelTriggerTypes, registerSeedFeatures } from "./seed/register.js";
import { servedLegKeysMiddleware } from "./lib/served-leg-keys.js";
import { legacyLegKeyArrivalsMiddleware } from "./lib/legacy-leg-key-arrivals.js";
import { migrateOutboundLegKeys } from "./lib/outbound-leg-key-migration.js";
import { migrateLeadSourcingFunnelKeys } from "./lib/lead-sourcing-key-migration.js";
import { renamePipesToBirds } from "./lib/sales-path-names.js";
import { listLegAssignments } from "./lib/workflow-leg-assignments.js";
import { pipeLegKeyOf } from "./lib/funnel-legs.js";
import { startViewKeeper } from "./lib/view-keeper.js";
import {
  announceViewRefresherReady,
  captureRequestReplay,
  startViewRefresher,
  viewCacheRole,
} from "./lib/view-refresher.js";

// ── Required env vars — crash at startup if missing ─────────────────────────
import { validateRequiredEnv } from "./lib/env.js";
validateRequiredEnv();

const app = express();
const PORT = process.env.PORT || 3010;

// Middleware
app.use(cors({
  origin: [
    "https://dashboard.mcpfactory.org",
    "https://mcpfactory.org",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3010",
  ],
  credentials: true,
}));
// Box health ingest carries its own larger JSON limit (a backfill chunk is ~1 MB), so it is mounted before the 100 kB default.
app.use(boxHealthRoutes);
// Box watchdog runs carry their own 2 MB JSON limit (a batch of runs with details), mounted before the 100 kB default too.
app.use(boxChecksRoutes);
app.use(express.json());
// Every view compute is asked of the refresher process (lib/view-refresher.ts), which needs the request.
app.use(captureRequestReplay);
// Outbound leg rename, wave 2: every JSON body goes out with outbound legs in their served spelling.
app.use(servedLegKeysMiddleware);
// Every legacy outbound leg key a caller still sends is logged (`legacy-outbound-leg-key`): the switch-off waits on 7 days of zero.
app.use(legacyLegKeyArrivalsMiddleware);

// Routes
app.use(healthRoutes);
app.use(factoryShadowRoutes);
app.use(publicRoutes);
app.use(featuresRoutes);
app.use(statsRoutes);
app.use(revenueRoutes);
app.use(workflowProjectionRoutes);
app.use(pipelineActivityRoutes);
app.use(audienceStatsRoutes);
app.use(offerEconomicsRoutes);
app.use(offerOutcomesRoutes);
app.use(brandLeadFamiliesRoutes);
app.use(offerSourcingRoutes);
app.use(offerSalesPathsRoutes);
app.use(usageRoutes);
app.use(writtenByRoutes);
app.use(sourcingInvestmentRoutes);
app.use(brandEconomicsRoutes);
app.use(contactedValueRoutes);
app.use(dealsValueRoutes);
app.use(brandCompaniesRoutes);
app.use(offerLeadValuesRoutes);
app.use(conversionRatesRoutes);
app.use(rateSourcesRoutes);
app.use(viewCacheAdminRoutes);
app.use(workflowLegAssignmentsRoutes);
app.use(channelDeclarationsRoutes);
app.use(agentCatalogueRoutes);
app.use(transferBrandRoutes);
app.use(orgPeriodRecapRoutes);
app.use(salesFunnelCampaignsRoutes);
app.use(salesFunnelCampaignActivityRoutes);
app.use(campaignNextStepsRoutes);
app.use(spendChartsRoutes);
app.use(campaignMilestonesRoutes);
app.use(campaignTargetsRoutes);
app.use(publishedUnitsRoutes);
app.use(outcomeCostSeriesRoutes);
app.use(livedSalesPathsRoutes);
app.use(fleetIndexesRoutes);
app.use(researchRoutes);
app.use(scriptStrategyRoutes);
app.use(engineStrategyRoutes);
app.use(engineLlmRatingRoutes);
app.use(unitReportsRoutes);
app.use(scriptRatingRoutes);
app.use(scriptEnginesRoutes);
app.use(customerHealthRoutes);
app.use(securityAdvisoriesRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry error handler must be before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Fallback error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/**
 * The boot warms of the SERVING process, in the order they run (one at a time, `lib/boot-warms.ts`). Every step starts
 * from its stored copy and skips while that copy is fresh; meanwhile every read serves the stored copy.
 */
async function bootWarmSteps(): Promise<BootWarmStep[]> {
  const steps: BootWarmStep[] = [
    // The onboarding prices each outcome off this payload; its fleet walks must never run on a read.
    { name: "outcome prices", run: () => warmOutcomePrices() },
    // The agent catalogue's pipe economics are fleet walks too: built off the request path.
    { name: "agent catalogue figures", run: () => warmCatalogueMeasurementsOnBoot() },
    // The LLM Rating's evidence (every LLM call per Engine, LLM-RATING-PER-ENGINE-1112): stored, skipped while fresh.
    { name: "LLM rating evidence", run: () => warmEngineLlmEvidence() },
    // Monitoring's board of what the Rating picks per Engine (SCRIPT-VALUE-RATING-1113-MON): stored, skipped while fresh.
    { name: "script engines board", run: () => warmScriptEngines() },
  ];
  // Every pipe a workflow is assigned to gets its fleet ranking warmed, whatever its channel (owner 2026-10-10: no
  // special case; this used to warm the two cold-email pipes only).
  const rows = await listLegAssignments().catch((err) => {
    console.error("[features-service] leg workflow ranking boot warm: assignments unreadable, no ranking warmed this boot:", err);
    return [];
  });
  for (const key of new Set(rows.map((r) => `${r.featureSlug}\u0000${r.legKey}`))) {
    const [featureSlug, legKey] = key.split("\u0000");
    steps.push({ name: `leg workflow ranking ${featureSlug}|${legKey}`, run: () => warmLegWorkflowRankingOnBoot(featureSlug, pipeLegKeyOf(featureSlug, legKey)) });
  }
  // The best template and LLM of every pipe holding a workflow (routes/leg-writer-ranking.ts, BEST-TPL-LLM-1022), after the
  // workflow rankings whose fleet cells it shares (MON-BOOT-SPIKE-1112: it used to fire on its own at +3 min, every pipe rebuilt).
  const writerPipes = await legWriterRankingBootPipes().catch((err) => {
    console.error("[features-service] leg writer ranking boot warm: assignments unreadable, no ranking warmed this boot:", err);
    return [];
  });
  for (const p of writerPipes) {
    steps.push({ name: `leg writer ranking ${p.featureSlug}|${p.legKey}`, run: () => warmLegWriterRankingOnBoot(p.featureSlug, p.legKey) });
  }
  // The homepage showcase reads the snapshot rows, so it runs after them (it is held in memory: built once per boot).
  steps.push({ name: "fleet brand snapshots", run: () => warmFleetBrandSnapshotsOnBoot() });
  steps.push({ name: "showcase", run: () => warmShowcaseFunnelsOnBoot() });
  // The staff customer-health board (routes/customer-health.ts), last: its build is the heaviest (it runs in the refresher).
  steps.push({ name: "customer health board", run: () => warmCustomerHealthOnBoot() });
  return steps;
}

/**
 * Build the fleet positive-repliers cell (lib/fleet-positive-repliers.ts) for every cold-email channel in
 * the process that computes workflow projections, so the first ladder read after a deploy does not wait
 * on a whole-fleet lead walk. Sequential across channels; fire-and-forget; failures are logged.
 */
function warmFleetPositiveRepliersOnBoot(): void {
  void (async () => {
    try {
      const all = await db.query.features.findMany({ columns: { slug: true } });
      for (const slug of coldEmailOutreachSlugs(all.map((f) => f.slug))) await warmFleetPositiveRepliers(slug);
    } catch (err) {
      console.error("[features-service] fleet positive repliers boot warm failed:", err);
    }
  })();
}

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test" && viewCacheRole() === "refresher") {
  // The REFRESHER (forked by the server below): computes Gold views off the serving event loop. The
  // server already migrated and seeded, and the boot warms are the server's; it only listens, locally.
  app.listen(Number(PORT), "127.0.0.1", () => {
    console.log(`[features-service] view refresher listening on 127.0.0.1:${PORT}`);
    announceViewRefresherReady();
    // Workflow projections are computed HERE, so this is the process whose fleet cell must be warm.
    warmFleetPositiveRepliersOnBoot();
    // Every priced compute reads the fleet conversion-rate medians (in-memory per process).
    warmFleetStatedMediansOnBoot();
  });
} else if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(async () => {
      console.log("[features-service] Migrations complete");
      await registerSeedFeatures();
      await registerChannelTriggerTypes();
      // Re-key every stored outbound leg to its new spelling (idempotent, three small tables; re-run at
      // every boot so a row an older process wrote during a deploy is moved on the next one).
      await migrateOutboundLegKeys();
      // One channel per leg (owner 2026-10-11): a funnel name stored under its pre-sourcing-leg id moves to its Lead
      // Sourcing id (idempotent, same lock; `lib/lead-sourcing-key-migration.ts`).
      await migrateLeadSourcingFunnelKeys();
      // Owner GO 2026-10-10: every pipe named before the families split takes a bird (idempotent).
      await renamePipesToBirds();
      app.listen(Number(PORT), "::", () => {
        console.log(`Features service running on port ${PORT}`);
        // Fork the view refresher after the port binds: its boot must never hold up the health check.
        startViewRefresher(process.argv[1]);
        // Precompute the sibling scopes of every brand a customer reads (lib/view-keeper.ts). Timers are
        // unref'd and the first round waits a minute, so nothing here sits between boot and the port.
        startViewKeeper();
        // The fleet rebuilds a fresh process owes (MON-PAGE-SPEED-2-1112, lib/boot-warms.ts): ONE AT A TIME, 30 s after
        // listen, each starting from the copy the previous process STORED and skipping when it is still fresh. Before,
        // all of them fired here at once (prod 2026-11-12: load 15 -> 22, cached dashboard reads 1-8 s for minutes).
        scheduleBootWarms(bootWarmSteps);
        // Jev judges every workflow version against every tactic once (lib/tactic-judgments.ts): first sweep a minute
        // after listen, then every 15 min, single-flight.
        startTacticJudgmentLoop();
        // The public fleet indexes (lib/fleet-indexes.ts): today's point a minute after listen, then hourly.
        startFleetIndexRecorder();
        // The Research studies (routes/research.ts): built off the request path by the refresher (two minutes in, once it
        // is up), the persisted copy served meanwhile.
        // Our copy of instantly-service's outreach facts (lib/outreach-facts-copy.ts): followed every 2 minutes.
        startOutreachFactsCopy();
        // ... and of content-generation-service's sequence feed (lib/generation-sequences-copy.ts), every 2 minutes.
        startGenerationSequencesCopy();
        // Both views of the billed basis (MATURITY-VIEW-1023), one after the other, two minutes in, then every 5 minutes
        // (RESEARCH-STALE-1024: rebuilt on a clock, never only when someone reads the page).
        startResearchRefreshLoop();
        // GTM Factory step 1, shadow only (routes/factory-shadow.ts): the brief judge + shadow plan of every live funnel campaign,
        // ten minutes in, then every 3 hours; never computed on a read.
        startFactoryShadowLoop();
        // Every newsletter release's run total (published Units, OUTCOME-FINEST-1106), built ahead of any Outcome page.
        startBulkRunSweep();
        // A campaign whose Engine cannot run is red on Monitoring (NO-BRIEF-UNBLOCK-1111, lib/engine-held-monitor.ts).
        startEngineHeldMonitor();
        // The LLM Rating's evidence, rebuilt every 15 minutes (LLM-RATING-PER-ENGINE-1112).
        startEngineLlmEvidenceLoop();
        // Monitoring's board of what the Rating picks per Engine, rebuilt every 15 minutes (SCRIPT-VALUE-RATING-1113-MON).
        startScriptEnginesLoop();
        // ... from our copy of every LLM call the fleet made, followed every 2 minutes (lib/llm-call-feed.ts).
        startLlmCallFeed();
        // Every priced read (lead families' cache key included) reads the fleet medians first.
        warmFleetStatedMediansOnBoot();
        // With the refresher off, projections compute in this process — warm its fleet cell instead.
        if (process.env.VIEW_REFRESHER_ENABLED === "false") warmFleetPositiveRepliersOnBoot();
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
