/**
 * GET /internal/stats/customer-health: the staff customer-health board, served from its LAST BUILD
 * (CUSTOMER-HEALTH-OOM-1023).
 *
 * WHY. The board enriches every customer with three whole dashboard computes (brand revenue, audience stats,
 * workflow projection). Built on the request path of the serving process, two reads on 2026-10-23 ran 90 s each
 * and took the process past its 816 MB heap limit: the container died twice and every caller of features-service
 * got ECONNREFUSED while it restarted.
 *
 * NOW. A read never builds. It serves the last build at once (in memory, else the persisted copy) and, when that
 * build is older than `FRESH_MS`, asks for ONE rebuild behind it. The rebuild runs in the forked view refresher
 * (lib/view-refresher.ts, respawned if it dies), so a build that runs out of memory takes down the refresher, not
 * the server; with the refresher off it runs here. A board never built answers 503 `customer_health_not_computed_yet`
 * while the first build runs. The body states its age: `freshness {computedAt, refreshEveryMinutes}`.
 *
 *   server read ──► memory / persisted copy ──► 200 (any age)            stale ─► kick ONE rebuild
 *   rebuild: server ─► refresher POST …/build (202) ─► poll …/build-status ─► load the persisted copy
 */
import { Router } from "express";
import { apiKeyOnly } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { buildCustomerHealthBoard, type CustomerHealthBoard } from "../lib/customer-health-compute.js";
import { loadFleetCell, storeFleetCell, type StoredCell } from "../lib/fleet-cell-store.js";
import { refresherBaseUrl } from "../lib/view-refresher.js";
import { routeResponseShapeFingerprint } from "../lib/response-shape.js";

const ROUTE = "/internal/stats/customer-health";
/** A build younger than this is served without asking for a new one. */
export const FRESH_MS = 15 * 60_000;
/** A build that has not finished by then is given up (the next read asks again). */
const BUILD_TIMEOUT_MS = 60 * 60_000;
/** A failed build is not retried on every read. */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const POLL_MS = 15_000;

/** The body as served: the board and its age. */
export type CustomerHealthBody = CustomerHealthBoard & {
  freshness: { computedAt: string; refreshEveryMinutes: number };
};

export interface CustomerHealthServingDeps {
  computeBoard: () => Promise<CustomerHealthBoard>;
  loadCell: (key: string) => Promise<StoredCell | null>;
  storeCell: (key: string, text: string, computedAt: number) => Promise<void>;
  refresherBase: () => string | null;
  fetchImpl: typeof fetch;
  pollMs: number;
}

const REAL_DEPS: CustomerHealthServingDeps = {
  computeBoard: async () => {
    const allFeatures = await db.query.features.findMany({ columns: { slug: true } });
    // Every GTM channel (CUSTOMER-HEALTH-ALL-GTM-1023, owner « Oui ces tout GTM »). Only THIS board widens: the Accounts
    // audit, MRR, revenue history and send-forecast keep their cold-email universe.
    return buildCustomerHealthBoard(allFeatures.map((f) => f.slug).join(","), new Date());
  },
  loadCell: loadFleetCell,
  storeCell: storeFleetCell,
  refresherBase: refresherBaseUrl,
  fetchImpl: (...args) => fetch(...args),
  pollMs: POLL_MS,
};
let deps: CustomerHealthServingDeps = REAL_DEPS;

/** The persisted copy is keyed on this route's response shape: a deploy changing another route keeps it warm. */
const cellKey = () => `customer-health:${routeResponseShapeFingerprint(ROUTE)}`;

let held: { text: string; computedAt: number } | null = null;
let loadedPersisted = false;
let building: Promise<void> | null = null;
let failedAt = 0;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function bodyText(board: CustomerHealthBoard, computedAt: number): string {
  const body: CustomerHealthBody = {
    ...board,
    freshness: { computedAt: new Date(computedAt).toISOString(), refreshEveryMinutes: FRESH_MS / 60_000 },
  };
  return JSON.stringify(body);
}

/** Build in THIS process and persist. The refresher's job (or the server's when the refresher is off). */
async function buildHere(): Promise<{ text: string; computedAt: number }> {
  const board = await deps.computeBoard();
  const computedAt = Date.now();
  const text = bodyText(board, computedAt);
  await deps.storeCell(cellKey(), text, computedAt);
  return { text, computedAt };
}

const apiHeaders = () => ({ "x-api-key": process.env.FEATURES_SERVICE_API_KEY ?? "" });

/**
 * Have the refresher build, wait for it (status polls, never one long request: a fetch gives up on headers
 * after 5 min), then read the copy it persisted. Never builds here: the refresher being down is a failure,
 * retried later, because building in the server is exactly what took it down.
 */
async function buildInRefresher(base: string): Promise<{ text: string; computedAt: number }> {
  const asked = await deps.fetchImpl(`${base}${ROUTE}/build`, { method: "POST", headers: apiHeaders() });
  if (asked.status !== 202) throw new Error(`refresher answered ${asked.status} to the board build: ${(await asked.text()).slice(0, 300)}`);
  const { buildId } = (await asked.json()) as { buildId: number };
  for (;;) {
    await new Promise((r) => setTimeout(r, deps.pollMs));
    const res = await deps.fetchImpl(`${base}${ROUTE}/build-status`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`refresher answered ${res.status} to the board build status`);
    const s = (await res.json()) as BuildStatus;
    if (s.lastFinished && s.lastFinished.buildId >= buildId) {
      if (s.lastFinished.error) throw new Error(`refresher board build failed: ${s.lastFinished.error}`);
      const stored = await deps.loadCell(cellKey());
      if (!stored) throw new Error("refresher finished the board build but no copy is stored");
      return { text: stored.text, computedAt: stored.computedAt };
    }
    if (!s.running) throw new Error("refresher holds no board build (it restarted, or the build was lost)");
  }
}

/** Ask for one rebuild unless the held build is fresh, one is running, or the last one failed under 10 min ago. */
export function warmCustomerHealth(): Promise<void> {
  if (held && Date.now() - held.computedAt < FRESH_MS) return Promise.resolve();
  if (building) return building;
  if (Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve();
  const base = deps.refresherBase();
  building = withTimeout(base ? buildInRefresher(base) : buildHere(), BUILD_TIMEOUT_MS, "customer-health board")
    .then((built) => {
      if (!held || built.computedAt >= held.computedAt) held = built;
    })
    .catch((error) => {
      failedAt = Date.now();
      console.error("[features-service] customer-health board build failed, serving the previous one (next try in 10 min):", error);
    })
    .finally(() => {
      building = null;
    });
  return building;
}

/** The last build as JSON text (the persisted copy on a fresh process); kicks a rebuild when stale. Null = never built. */
export async function readCustomerHealthText(): Promise<string | null> {
  if (!held && !loadedPersisted) {
    loadedPersisted = true;
    const stored = await deps.loadCell(cellKey());
    if (stored && !held) held = { text: stored.text, computedAt: stored.computedAt };
  }
  void warmCustomerHealth();
  return held?.text ?? null;
}

// ── Refresher side: one build at a time, its outcome kept for the server's status polls ──────────────────

interface BuildStatus {
  running: boolean;
  lastFinished: { buildId: number; finishedAt: string; error: string | null } | null;
}
let nextBuildId = 1;
let runningBuild: { buildId: number; promise: Promise<void> } | null = null;
let lastFinished: BuildStatus["lastFinished"] = null;

function startBuildHere(): number {
  if (runningBuild) return runningBuild.buildId;
  const buildId = nextBuildId++;
  const promise = withTimeout(buildHere(), BUILD_TIMEOUT_MS, "customer-health board (refresher)")
    .then(() => {
      lastFinished = { buildId, finishedAt: new Date().toISOString(), error: null };
    })
    .catch((error) => {
      console.error("[features-service] customer-health board build (refresher) failed:", error);
      lastFinished = { buildId, finishedAt: new Date().toISOString(), error: ((error as Error)?.message ?? String(error)).slice(0, 300) };
    })
    .finally(() => {
      runningBuild = null;
    });
  runningBuild = { buildId, promise };
  return buildId;
}

/** Test seams. */
export function __setCustomerHealthServingDeps(next: Partial<CustomerHealthServingDeps> | null): void {
  deps = next ? { ...REAL_DEPS, ...next } : REAL_DEPS;
}
export function __resetCustomerHealthServing(): void {
  held = null;
  loadedPersisted = false;
  building = null;
  failedAt = 0;
  runningBuild = null;
  lastFinished = null;
}
export async function __awaitCustomerHealthBuild(): Promise<void> {
  await building;
  await runningBuild?.promise;
}

const router = Router();

router.get(ROUTE, apiKeyOnly, async (_req, res) => {
  try {
    const text = await readCustomerHealthText();
    if (text === null) {
      res.status(503).json({
        error: "The customer-health board has not been computed yet: its first build is running.",
        reason: "customer_health_not_computed_yet",
      });
      return;
    }
    res.type("application/json").send(text);
  } catch (error) {
    console.error("[features-service] Internal stats customer-health error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post(`${ROUTE}/build`, apiKeyOnly, (_req, res) => {
  // The server never builds the board when a refresher exists: that build is what took it down.
  if (deps.refresherBase()) {
    res.status(409).json({ error: "The board is built by the view refresher, not this process.", reason: "build_runs_in_refresher" });
    return;
  }
  res.status(202).json({ buildId: startBuildHere() });
});

router.get(`${ROUTE}/build-status`, apiKeyOnly, (_req, res) => {
  const status: BuildStatus = { running: runningBuild !== null, lastFinished };
  res.json(status);
});

export default router;
