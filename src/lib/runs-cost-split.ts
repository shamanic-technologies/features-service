/**
 * A LIFETIME runs-service cost aggregate (`GET /v1/stats/costs` with no time bound), answered as
 * the sum of two reads: everything that STARTED BEFORE TODAY (UTC) and everything that started
 * today — so an interactive view refreshing every few seconds re-scans only today's runs.
 *
 * WHY. These aggregates are live queries over a brand's whole run ledger (1-3.5s each on the busiest
 * brand) and a campaign Overview makes several per refresh (features-service#1045). Refreshing the
 * Overview every few seconds with them would multiply runs-service's database load. Split, the
 * expensive half is asked at most once per {@link PAST_PART_REUSE_MS} — the cadence it was asked at
 * before, when a view refreshed every ~30s — and re-asked BEHIND the answer (the previous past half is
 * served while it is re-read, up to twice that age), so no refresh waits on the expensive scan. The
 * part a new send or a new cost lands in (today) is read fresh on every refresh, cheaply (a bounded
 * range scan).
 *
 * WHAT IT CHANGES IN A FIGURE. Nothing a reader can see: runs-service groups by the run's
 * `started_at` and both bounds are inclusive, so `<= today - 1µs` and `>= today` partition the
 * ledger exactly (timestamptz has microsecond precision). Money is summed as exact decimals and
 * rendered in the producer's own 10-decimal text; run counts add; min/max started-at combine. The
 * only residual is the producer's per-group rounding to 10 decimals, now applied twice (≤1e-10¢).
 * A change to a run that started before today (a follow-up hold actualized or released) reaches the
 * figure within 30-60s — about the staleness every figure had before (a 30s TTL plus a recompute).
 *
 * FAIL LOUD: a group field this merge does not know how to combine throws rather than being dropped.
 */
export const PAST_PART_REUSE_MS = 30_000;

type Group = Record<string, unknown> & { dimensions?: Record<string, unknown> };

/** Exact sum of two decimal strings, rendered with the larger of their decimal counts. */
function addDecimals(x: unknown, y: unknown, field: string): string {
  const parse = (raw: unknown) => {
    const str = String(raw);
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str);
    if (!m) throw new Error(`runs-service cost group ${field} is not a decimal: ${JSON.stringify(raw)}`);
    return { neg: m[1] === "-", int: m[2], frac: m[3] ?? "" };
  };
  const a = parse(x);
  const b = parse(y);
  const places = Math.max(a.frac.length, b.frac.length);
  const scaled = (p: { neg: boolean; int: string; frac: string }) => {
    const v = BigInt(p.int + p.frac.padEnd(places, "0"));
    return p.neg ? -v : v;
  };
  const sum = scaled(a) + scaled(b);
  const neg = sum < 0n;
  const digits = (neg ? -sum : sum).toString().padStart(places + 1, "0");
  const int = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places);
  return `${neg ? "-" : ""}${int}${places > 0 ? `.${frac}` : ""}`;
}

/** Numeric value of a decimal string, for ordering only. */
function decimalValue(raw: unknown): number {
  return Number(raw ?? 0);
}

function mergeGroup(a: Group, b: Group): Group {
  const out: Group = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (key === "dimensions") continue;
    const prev = a[key];
    if (prev === undefined || prev === null) {
      out[key] = value;
    } else if (value === undefined || value === null) {
      out[key] = prev;
    } else if (key.endsWith("CostInUsdCents") || key.endsWith("Quantity")) {
      out[key] = addDecimals(prev, value, key);
    } else if (key === "runCount") {
      out[key] = Number(prev) + Number(value);
    } else if (key === "minStartedAt") {
      out[key] = String(prev) <= String(value) ? prev : value;
    } else if (key === "maxStartedAt") {
      out[key] = String(prev) >= String(value) ? prev : value;
    } else {
      throw new Error(`runs-service cost group field ${key} cannot be combined across a past/today split`);
    }
  }
  return out;
}

/** Sum two `{groups}` answers of the same query over disjoint time ranges. */
export function mergeCostAnswers(past: { groups?: Group[] }, today: { groups?: Group[] }): { groups: Group[] } {
  if (!Array.isArray(past.groups) || !Array.isArray(today.groups)) {
    throw new Error("runs-service /v1/stats/costs split read returned no groups array");
  }
  const byDims = new Map<string, Group>();
  for (const group of [...past.groups, ...today.groups]) {
    const key = JSON.stringify(group.dimensions ?? {});
    const existing = byDims.get(key);
    byDims.set(key, existing ? mergeGroup(existing, group) : { ...group });
  }
  // The producer orders by committed cost, highest first.
  return {
    groups: [...byDims.values()].sort((x, y) => decimalValue(y.totalCostInUsdCents) - decimalValue(x.totalCostInUsdCents)),
  };
}

/**
 * Whether `url` is a lifetime `/v1/stats/costs` read this split can serve: no time bound of its own.
 * Returns the two URLs to ask, or null.
 */
export function splitLifetimeCostUrl(url: string, now = new Date()): { past: string; today: string; day: string } | null {
  if (!/\/v1\/stats\/costs(\?|$)/.test(url)) return null;
  const u = new URL(url);
  if (u.searchParams.has("startedAfter") || u.searchParams.has("startedBefore")) return null;
  const day = now.toISOString().slice(0, 10);
  const todayStart = new Date(`${day}T00:00:00.000Z`);
  const past = new URL(u);
  past.searchParams.set("startedBefore", `${new Date(todayStart.getTime() - 1).toISOString().slice(0, 23)}999Z`);
  const today = new URL(u);
  today.searchParams.set("startedAfter", todayStart.toISOString());
  return { past: past.toString(), today: today.toString(), day };
}
