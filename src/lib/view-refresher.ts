import { AsyncLocalStorage } from "node:async_hooks";
import { fork, type ChildProcess } from "node:child_process";
import type { NextFunction, Request, Response } from "express";

/**
 * THE VIEW REFRESHER — every Gold snapshot compute runs in a SEPARATE Node process, so the process that
 * answers the dashboard only ever reads snapshots.
 *
 * WHY. A view compute is an engine pass over a brand's whole lead population (JSON parse of the live
 * lead copy, the per-lead EV walk, the response build). It is CPU work, and Node runs it on the SAME
 * event loop that answers every other request. Measured in prod 2026-09-26 (features-service, box load
 * 14-17 on 8 cores): `/health` — a handler that does nothing — took up to 576ms with no load of ours and
 * 1.1s while a brand's money views refreshed, and the snapshot reads that serve the dashboard (50-150ms
 * at p50) spiked to 0.6-3s at p95 for the same reason. The snapshot was there; the loop was busy.
 *
 * HOW. The serving process (`server` role) records each request's replayable shape (GET url + headers)
 * in an AsyncLocalStorage. When `servedCached` needs a compute — a miss, a stale refresh, a rotation —
 * it asks the refresher (`refresher` role, forked at boot, same build, its own event loop and heap) to
 * replay the SAME request with `x-view-refresh: <view + key family>`. The refresher runs the ordinary
 * handler; the one `servedCached` call matching that target computes + persists and its value is sent
 * back at once. Any view a request reads — the response's own cell or one read before it (effective
 * rates, step counts) — is refreshed this way, so no compute of a request ever runs on the server.
 *
 * NOTHING ABOUT A FIGURE MOVES: the refresher runs the identical handler on the identical request, and
 * the body it persists is the body a local compute would have persisted. If the refresher cannot be
 * reached or answers non-2xx, the compute runs locally — loudly — so an error still surfaces as the
 * typed status its handler maps (a 404/409 stays a 404/409, never a generic 502).
 */

export const REFRESH_HEADER = "x-view-refresh";

export function viewCacheRole(): "server" | "refresher" {
  return process.env.VIEW_CACHE_ROLE === "refresher" ? "refresher" : "server";
}

/** The one view a refresh request asks for: its name and its key FAMILY (fingerprint parts dropped). */
interface RefreshTarget {
  view: string;
  familyKey: string;
}

interface RequestReplay {
  /** The request, replayable against the refresher. Absent for a non-GET (never delegated). */
  url?: string;
  headers?: Record<string, string>;
  /** Refresher role: the view this request was sent to compute and persist. */
  target?: RefreshTarget;
  /** Refresher role: sends the computed value to the server, once. */
  answer?: (value: unknown) => void;
}

/**
 * The refresher answers the COMPUTED value in this envelope, not the handler's response: a handler may
 * shape the cached value before sending it (audience-stats caches a result union and maps it to a
 * status), and the server's `servedCached` must return exactly what a local compute would have.
 */
const ENVELOPE = "__viewRefresherComputed";

const replayStore = new AsyncLocalStorage<RequestReplay>();

/** Headers that describe the connection, not the question — never replayed. */
const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
  // A conditional request would let the refresher answer 304 with no body.
  "if-none-match",
  "if-modified-since",
]);

const encodeTarget = (target: RefreshTarget): string => Buffer.from(JSON.stringify(target)).toString("base64url");

function decodeTarget(raw: string): RefreshTarget | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as RefreshTarget;
    return typeof parsed?.view === "string" && typeof parsed?.familyKey === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Express middleware: record the replayable request for the whole async life of its handler. */
export function captureRequestReplay(req: Request, res: Response, next: NextFunction): void {
  const replay: RequestReplay = {};
  const rawTarget = req.headers[REFRESH_HEADER];
  if (viewCacheRole() === "refresher" && typeof rawTarget === "string") {
    replay.target = decodeTarget(rawTarget);
    if (replay.target) {
      // The moment the target view has its value, the server gets it — the rest of the handler (other
      // views, the response shaping) runs on here but answers nobody: its status and body are dropped.
      const json = res.json.bind(res);
      const status = res.status.bind(res);
      let sent = false;
      replay.answer = (value) => {
        if (sent) return;
        sent = true;
        status(200);
        json({ [ENVELOPE]: value });
      };
      res.status = ((code: number) => (sent ? res : status(code))) as Response["status"];
      res.json = ((payload: unknown) => (sent ? res : json(payload))) as Response["json"];
    }
  }
  if (req.method === "GET") {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(name) || name === REFRESH_HEADER || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    replay.url = req.originalUrl;
    replay.headers = headers;
  }
  replayStore.run(replay, next);
}

/**
 * Server role: where this request's compute of `view` may be asked — the refresher, replaying the
 * request with this view as its target. `null` outside a request (boot warms, fleet sweeps), for a
 * non-GET, in the refresher itself, or while no refresher is up: the ordinary in-process path.
 */
export function refresherDelegation(view: string, familyKey: string): { url: string; headers: Record<string, string> } | null {
  const replay = replayStore.getStore();
  const port = process.env.VIEW_REFRESHER_PORT;
  if (!replay?.url || !replay.headers || viewCacheRole() !== "server" || !port) return null;
  return {
    url: `http://127.0.0.1:${port}${replay.url}`,
    headers: { ...replay.headers, [REFRESH_HEADER]: encodeTarget({ view, familyKey }) },
  };
}

/**
 * Refresher role: when THIS call is the view the server asked for, a function that sends it its value
 * (the call must then compute + persist, never serve a snapshot). Matched on the key FAMILY, so a
 * fingerprint that moved between the two processes still finds its call. First match only.
 */
export function forcedRefresh(view: string, familyKey: string): ((value: unknown) => void) | null {
  const replay = replayStore.getStore();
  if (!replay?.target || !replay.answer || replay.target.view !== view || replay.target.familyKey !== familyKey) return null;
  const answer = replay.answer;
  replay.target = undefined; // first match only
  return answer;
}

/**
 * Ask the refresher to compute + persist one view of one request and return its value. Returns
 * `undefined` (after a loud log) when it could not, so the caller computes locally — which also means
 * an error surfaces here as the typed status its handler maps (a 404/409 stays a 404/409).
 */
export async function computeViaRefresher(url: string, headers: Record<string, string>): Promise<{ body: unknown } | undefined> {
  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    const parsed = res.ok ? (JSON.parse(text) as Record<string, unknown> | null) : null;
    if (!parsed || typeof parsed !== "object" || !(ENVELOPE in parsed)) {
      console.error(`[features-service] view refresher computed nothing for ${new URL(url).pathname} (${res.status}; computing locally): ${text.slice(0, 300)}`);
      return undefined;
    }
    return { body: parsed[ENVELOPE] };
  } catch (err) {
    console.error(`[features-service] view refresher unreachable (computing locally): ${(err as Error).message}`);
    return undefined;
  }
}

// ── Boot: fork and supervise the refresher ────────────────────────────────────────────────────────

const DEFAULT_REFRESHER_PORT = 8091;
const RESPAWN_DELAY_MS = 5_000;

/**
 * Fork the refresher (the same entrypoint, `VIEW_CACHE_ROLE=refresher`) and point this process at it.
 * Respawned on exit. `VIEW_REFRESHER_ENABLED=false` keeps every compute in-process (the kill switch).
 */
export function startViewRefresher(entrypoint: string): void {
  if (process.env.VIEW_REFRESHER_ENABLED === "false" || viewCacheRole() !== "server") return;
  const port = Number(process.env.VIEW_REFRESHER_PORT_OVERRIDE ?? DEFAULT_REFRESHER_PORT);
  const spawn = () => {
    const child: ChildProcess = fork(entrypoint, [], {
      env: { ...process.env, VIEW_CACHE_ROLE: "refresher", PORT: String(port), VIEW_REFRESHER_PORT: "" },
      stdio: "inherit",
    });
    child.on("message", (message) => {
      if (message === "view-refresher-ready") {
        process.env.VIEW_REFRESHER_PORT = String(port);
        console.log(`[features-service] view refresher ready on port ${port} (pid ${child.pid})`);
      }
    });
    child.on("exit", (code, signal) => {
      delete process.env.VIEW_REFRESHER_PORT;
      console.error(`[features-service] view refresher exited (code ${code}, signal ${signal}); computing in-process, respawning in ${RESPAWN_DELAY_MS}ms`);
      setTimeout(spawn, RESPAWN_DELAY_MS).unref();
    });
  };
  spawn();
}

/** Refresher role: tell the server this process is listening. */
export function announceViewRefresherReady(): void {
  if (viewCacheRole() !== "refresher" || typeof process.send !== "function") return;
  // An orphaned refresher would hold its port and block the next server's child: go with the parent.
  process.on("disconnect", () => process.exit(0));
  process.send("view-refresher-ready");
}
