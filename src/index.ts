// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./db/index.js";
import { warmFleetPositiveRepliers } from "./lib/fleet-positive-repliers.js";
import { coldEmailOutreachSlugs } from "./lib/send-forecast-compute.js";
import healthRoutes from "./routes/health.js";
import featuresRoutes from "./routes/features.js";
import statsRoutes from "./routes/stats.js";
import revenueRoutes from "./routes/revenue.js";
import workflowProjectionRoutes from "./routes/workflow-projection.js";
import pipelineActivityRoutes from "./routes/pipeline-activity.js";
import offerEconomicsRoutes from "./routes/offer-economics.js";
import offerOutcomesRoutes from "./routes/offer-outcomes.js";
import offerSalesPathsRoutes from "./routes/offer-sales-paths.js";
import usageRoutes from "./routes/usage.js";
import brandEconomicsRoutes from "./routes/brand-economics.js";
import contactedValueRoutes from "./routes/contacted-value.js";
import dealsValueRoutes from "./routes/deals-value.js";
import conversionRatesRoutes from "./routes/conversion-rates.js";
import audienceStatsRoutes from "./routes/audience-stats.js";
import publicRoutes, { warmFleetReturnSnapshotsOnBoot, warmShowcaseFunnelsOnBoot, warmOutcomePrices, warmLegWorkflowRanking } from "./routes/public.js";
import viewCacheAdminRoutes from "./routes/view-cache-admin.js";
import workflowLegAssignmentsRoutes from "./routes/workflow-leg-assignments.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import { registerSeedFeatures } from "./seed/register.js";
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
app.use(express.json());
// Every view compute is asked of the refresher process (lib/view-refresher.ts), which needs the request.
app.use(captureRequestReplay);

// Routes
app.use(healthRoutes);
app.use(publicRoutes);
app.use(featuresRoutes);
app.use(statsRoutes);
app.use(revenueRoutes);
app.use(workflowProjectionRoutes);
app.use(pipelineActivityRoutes);
app.use(audienceStatsRoutes);
app.use(offerEconomicsRoutes);
app.use(offerOutcomesRoutes);
app.use(offerSalesPathsRoutes);
app.use(usageRoutes);
app.use(brandEconomicsRoutes);
app.use(contactedValueRoutes);
app.use(dealsValueRoutes);
app.use(conversionRatesRoutes);
app.use(viewCacheAdminRoutes);
app.use(workflowLegAssignmentsRoutes);
app.use(transferBrandRoutes);

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
  });
} else if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(async () => {
      console.log("[features-service] Migrations complete");
      await registerSeedFeatures();
      app.listen(Number(PORT), "::", () => {
        console.log(`Features service running on port ${PORT}`);
        // Fork the view refresher after the port binds: its boot must never hold up the health check.
        startViewRefresher(process.argv[1]);
        // Precompute the sibling scopes of every brand a customer reads (lib/view-keeper.ts). Timers are
        // unref'd and the first round waits a minute, so nothing here sits between boot and the port.
        startViewKeeper();
        // AFTER listen(), fire-and-forget: this is an O(brands) engine fan-out that takes MINUTES, so
        // awaiting it before the port bind would fail the deploy health check and roll the service back.
        warmFleetReturnSnapshotsOnBoot();
        // Same reason, same shape: the homepage gives its showcase read 8 seconds and drops the
        // section rather than block a build, so the cell must never be cold when it asks.
        warmShowcaseFunnelsOnBoot();
        // The onboarding prices each outcome off this payload; its fleet walks must never run on a read.
        void warmOutcomePrices();
        // Research reads the cold-email legs' fleet ranking; warm both so its first read is not empty.
        void warmLegWorkflowRanking("sales-cold-email-outreach", "start_to_conversation");
        void warmLegWorkflowRanking("sales-cold-email-outreach", "start_to_website_visit");
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
