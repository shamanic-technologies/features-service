/**
 * BOX HEALTH MONITOR (BOX-OVERLOAD-1026-SERIES). A cron on the production Hetzner box (every 5 minutes, posting from inside
 * this container) delivers SAMPLES of the box: load, memory, swap, OOM kills and, for live samples, the per-container CPU and
 * memory. A one-shot backfill replays the box's sysstat history (no per-container list). Stored one row per sample time
 * (`box_health_samples`, re-sending a time REPLACES it) and served to the staff Monitoring hub with a VERDICT the dashboard
 * renders as-is. Pure: no DB, no clock (the caller passes `now`).
 *
 * Red, from the LATEST sample, when: load average (5 min) > LOAD_PER_CORE_MAX x cores, MemAvailable < MEM_AVAILABLE_MIN_MB,
 * swap used > SWAP_USED_PCT_MAX % of swap total, swap total = 0, any OOM kill in the last OOM_WINDOW_HOURS, OR no sample in the
 * last STALE_AFTER_MINUTES (a blind monitor is loud, never read as "healthy"), OR nothing was ever sampled.
 */
import { z } from "zod";

export const LOAD_PER_CORE_MAX = 1.5;
export const MEM_AVAILABLE_MIN_MB = 1024;
export const SWAP_USED_PCT_MAX = 50;
export const OOM_WINDOW_HOURS = 24;
export const STALE_AFTER_MINUTES = 20;
export const RECENT_HOURS = 48;
export const TOP_CONTAINERS_WINDOW_MINUTES = 60;
export const TOP_CONTAINERS_LIMIT = 10;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 90;
export const RETENTION_DAYS = 90;
export const MAX_SAMPLES_PER_BATCH = 2000;

const nonNeg = z.number().finite().min(0);

export const BoxContainerSampleSchema = z.object({
  name: z.string().trim().min(1).max(200).describe("Container name, e.g. `distribute-features-service-1`."),
  cpuCores: nonNeg.describe("CPU used by the container, in CORES (1.0 = one full core), averaged since the previous sample."),
  memMb: nonNeg.describe("Memory used by the container, in MB."),
});

export const BoxHealthSampleSchema = z
  .object({
    sampledAt: z
      .string()
      .datetime({ offset: true })
      .describe("When the sample was taken (ISO 8601). The sample's identity: re-sending the same instant replaces it."),
    source: z.enum(["agent", "sysstat"]).describe("`agent` = the live 5-minute box cron; `sysstat` = the one-shot history backfill."),
    load1: nonNeg.describe("Load average over 1 minute."),
    load5: nonNeg.describe("Load average over 5 minutes."),
    load15: nonNeg.describe("Load average over 15 minutes."),
    cores: z.number().int().min(1).max(1024).describe("Number of CPU cores of the box."),
    memTotalMb: nonNeg.describe("Total RAM, MB."),
    memAvailableMb: nonNeg.describe("MemAvailable from /proc/meminfo, MB."),
    swapTotalMb: nonNeg.describe("Total swap, MB (0 = no swap configured, which is red)."),
    swapUsedMb: nonNeg.describe("Swap in use, MB."),
    oomKills: z
      .number()
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe("New kernel OOM kills since the previous sample. Absent/null when unknown (never read as 0)."),
    containers: z
      .array(BoxContainerSampleSchema)
      .max(500)
      .nullable()
      .optional()
      .describe("Per-container usage. Absent for backfilled history."),
  })
  .refine((s) => s.memAvailableMb <= s.memTotalMb, { message: "memAvailableMb cannot exceed memTotalMb" });

export const BoxHealthBatchSchema = z
  .object({
    samples: z.array(BoxHealthSampleSchema).min(1).max(MAX_SAMPLES_PER_BATCH).describe(`1 to ${MAX_SAMPLES_PER_BATCH} samples.`),
  })
  .refine((b) => new Set(b.samples.map((s) => Date.parse(s.sampledAt))).size === b.samples.length, {
    message: "each sampledAt appears once per batch",
  });

export type BoxHealthSample = z.infer<typeof BoxHealthSampleSchema>;
export type BoxContainerSample = z.infer<typeof BoxContainerSampleSchema>;

/** One stored sample, as the store returns it (`containers` null for backfill, or when the slim read skipped them). */
export interface StoredBoxSample {
  sampledAt: Date;
  source: "agent" | "sysstat";
  load1: number;
  load5: number;
  load15: number;
  cores: number;
  memTotalMb: number;
  memAvailableMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  oomKills: number | null;
  containers: BoxContainerSample[] | null;
}

/** What the view needs, as the store reads it. */
export interface BoxHealthInputs {
  /** Every sample of the window (or since the 48 h recent cut, whichever is earlier), containers NOT needed. */
  windowSamples: StoredBoxSample[];
  /** The most recent sample of all time, with containers; null when nothing was ever stored. */
  latest: StoredBoxSample | null;
  /** The `agent` samples of the last TOP_CONTAINERS_WINDOW_MINUTES, with containers. */
  lastHourAgentSamples: StoredBoxSample[];
}

export interface BoxHealthThresholds {
  loadPerCoreMax: number;
  load5Max: number | null;
  memAvailableMinMb: number;
  swapUsedPctMax: number;
  oomWindowHours: number;
  staleAfterMinutes: number;
}

export interface BoxDailyPoint {
  day: string;
  sampleCount: number;
  load5Mean: number;
  load5Max: number;
  memAvailableMinMb: number;
  swapUsedPctMax: number | null;
  oomKills: number | null;
}

export interface BoxRecentPoint {
  sampledAt: string;
  load1: number;
  load5: number;
  load15: number;
  memAvailableMb: number;
  swapUsedPct: number | null;
}

export interface BoxHealthView {
  status: "red" | "green";
  reason: string;
  reasons: string[];
  stale: boolean;
  minutesSinceLastSample: number | null;
  thresholds: BoxHealthThresholds;
  latest: (Omit<StoredBoxSample, "sampledAt"> & { sampledAt: string; swapUsedPct: number | null; oomKillsLast24h: number | null }) | null;
  windowDays: number;
  daily: BoxDailyPoint[];
  recentHours: number;
  recent: BoxRecentPoint[];
  topContainers: {
    windowMinutes: number;
    sampleCount: number;
    byCpu: Array<{ name: string; cpuCores: number }>;
    byMemory: Array<{ name: string; memMb: number }>;
  };
}

export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Start of the window: 00:00 UTC of the oldest of the `windowDays` UTC days ending today. */
export function windowStart(now: Date, windowDays: number): Date {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(end - (windowDays - 1) * 86_400_000);
}

export function swapUsedPctOf(s: Pick<StoredBoxSample, "swapTotalMb" | "swapUsedMb">): number | null {
  return s.swapTotalMb > 0 ? round1((s.swapUsedMb / s.swapTotalMb) * 100) : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  return known.length === 0 ? null : known.reduce((s, v) => s + v, 0);
}

export function buildBoxHealthView(inputs: BoxHealthInputs, now: Date, windowDays: number): BoxHealthView {
  const { latest } = inputs;
  const nowMs = now.getTime();
  const minutesSince = latest == null ? null : Math.max(0, (nowMs - latest.sampledAt.getTime()) / 60_000);
  const stale = minutesSince == null || minutesSince > STALE_AFTER_MINUTES;
  const load5Max = latest == null ? null : round2(LOAD_PER_CORE_MAX * latest.cores);

  const oomCut = nowMs - OOM_WINDOW_HOURS * 3_600_000;
  const oomSamples = inputs.windowSamples.filter((s) => s.sampledAt.getTime() > oomCut);
  if (latest && latest.sampledAt.getTime() > oomCut && !oomSamples.some((s) => s.sampledAt.getTime() === latest.sampledAt.getTime())) {
    oomSamples.push(latest);
  }
  const oomKillsLast24h = sumKnown(oomSamples.map((s) => s.oomKills));

  const reasons: string[] = [];
  if (latest == null) {
    reasons.push("No sample of the box has arrived yet: the box monitor is not running.");
  } else {
    if (stale) {
      reasons.push(
        `No sample for ${Math.floor(minutesSince!)} minutes (last one ${latest.sampledAt.toISOString()}): the box monitor is blind.`,
      );
    }
    if (latest.load5 > load5Max!) {
      reasons.push(`Load average ${latest.load5} over 5 minutes is above ${load5Max} (${LOAD_PER_CORE_MAX} x ${latest.cores} cores).`);
    }
    if (latest.memAvailableMb < MEM_AVAILABLE_MIN_MB) {
      reasons.push(`Only ${Math.round(latest.memAvailableMb)} MB of memory available (minimum ${MEM_AVAILABLE_MIN_MB} MB).`);
    }
    if (latest.swapTotalMb <= 0) {
      reasons.push("No swap is configured on the box.");
    } else {
      const pct = swapUsedPctOf(latest)!;
      // Judged on the exact ratio: the served percentage is rounded to 0.1 and would hide 50.01 % as 50.0 %.
      if ((latest.swapUsedMb / latest.swapTotalMb) * 100 > SWAP_USED_PCT_MAX) {
        reasons.push(
          `Swap is ${pct}% full (${Math.round(latest.swapUsedMb)} of ${Math.round(latest.swapTotalMb)} MB, limit ${SWAP_USED_PCT_MAX}%).`,
        );
      }
    }
  }
  if (oomKillsLast24h != null && oomKillsLast24h > 0) {
    reasons.push(`${oomKillsLast24h} process${oomKillsLast24h === 1 ? " was" : "es were"} killed for lack of memory in the last ${OOM_WINDOW_HOURS} hours.`);
  }
  const red = reasons.length > 0;
  if (!red) {
    reasons.push(
      `Box healthy: load ${latest!.load5} (limit ${load5Max}), ${Math.round(latest!.memAvailableMb)} MB memory available, swap ${swapUsedPctOf(latest!)}% full.`,
    );
  }

  // DAILY: one point per UTC day that HAS samples (a day without samples is absent: a gap, never a zero).
  const start = windowStart(now, windowDays).getTime();
  const byDay = new Map<string, StoredBoxSample[]>();
  for (const s of inputs.windowSamples) {
    if (s.sampledAt.getTime() < start) continue;
    const day = utcDayOf(s.sampledAt);
    const list = byDay.get(day);
    if (list) list.push(s);
    else byDay.set(day, [s]);
  }
  const daily: BoxDailyPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, ss]) => {
      const pcts = ss.map(swapUsedPctOf).filter((p): p is number => p != null);
      return {
        day,
        sampleCount: ss.length,
        load5Mean: round2(ss.reduce((t, s) => t + s.load5, 0) / ss.length),
        load5Max: round2(Math.max(...ss.map((s) => s.load5))),
        memAvailableMinMb: Math.round(Math.min(...ss.map((s) => s.memAvailableMb))),
        swapUsedPctMax: pcts.length === 0 ? null : Math.max(...pcts),
        oomKills: sumKnown(ss.map((s) => s.oomKills)),
      };
    });

  const recentCut = nowMs - RECENT_HOURS * 3_600_000;
  const recent: BoxRecentPoint[] = inputs.windowSamples
    .filter((s) => s.sampledAt.getTime() > recentCut)
    .sort((a, b) => a.sampledAt.getTime() - b.sampledAt.getTime())
    .map((s) => ({
      sampledAt: s.sampledAt.toISOString(),
      load1: s.load1,
      load5: s.load5,
      load15: s.load15,
      memAvailableMb: Math.round(s.memAvailableMb),
      swapUsedPct: swapUsedPctOf(s),
    }));

  // TOP CONTAINERS: mean over the last hour's agent samples IN WHICH the container appears.
  const topCut = nowMs - TOP_CONTAINERS_WINDOW_MINUTES * 60_000;
  const topSamples = inputs.lastHourAgentSamples.filter((s) => s.sampledAt.getTime() > topCut && s.containers != null);
  const acc = new Map<string, { cpu: number; mem: number; n: number }>();
  for (const s of topSamples) {
    for (const c of s.containers!) {
      const a = acc.get(c.name) ?? { cpu: 0, mem: 0, n: 0 };
      a.cpu += c.cpuCores;
      a.mem += c.memMb;
      a.n += 1;
      acc.set(c.name, a);
    }
  }
  const means = [...acc.entries()].map(([name, a]) => ({ name, cpuCores: round2(a.cpu / a.n), memMb: Math.round(a.mem / a.n) }));
  const byCpu = [...means]
    .sort((a, b) => b.cpuCores - a.cpuCores || a.name.localeCompare(b.name))
    .slice(0, TOP_CONTAINERS_LIMIT)
    .map(({ name, cpuCores }) => ({ name, cpuCores }));
  const byMemory = [...means]
    .sort((a, b) => b.memMb - a.memMb || a.name.localeCompare(b.name))
    .slice(0, TOP_CONTAINERS_LIMIT)
    .map(({ name, memMb }) => ({ name, memMb }));

  return {
    status: red ? "red" : "green",
    reason: reasons.join(" "),
    reasons,
    stale,
    minutesSinceLastSample: minutesSince == null ? null : round1(minutesSince),
    thresholds: {
      loadPerCoreMax: LOAD_PER_CORE_MAX,
      load5Max,
      memAvailableMinMb: MEM_AVAILABLE_MIN_MB,
      swapUsedPctMax: SWAP_USED_PCT_MAX,
      oomWindowHours: OOM_WINDOW_HOURS,
      staleAfterMinutes: STALE_AFTER_MINUTES,
    },
    latest:
      latest == null
        ? null
        : { ...latest, sampledAt: latest.sampledAt.toISOString(), swapUsedPct: swapUsedPctOf(latest), oomKillsLast24h },
    windowDays,
    daily,
    recentHours: RECENT_HOURS,
    recent,
    topContainers: { windowMinutes: TOP_CONTAINERS_WINDOW_MINUTES, sampleCount: topSamples.length, byCpu, byMemory },
  };
}
