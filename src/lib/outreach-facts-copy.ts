/**
 * OUR COPY OF INSTANTLY-SERVICE'S OUTREACH FACTS (LIVE-RESEARCH-1018). instantly-service states every dated thing our
 * cold email outreach did or saw for a person, append-only, in one total order (`GET /internal/outreach-facts`), "for a
 * consumer to COPY into its own store and then follow incrementally". The Research follow-up, timing, open-tracking and
 * machine-reply studies read the copy (`outreach_fact_copy`), never instantly-service's database.
 *
 *  - One row per SUBJECT (`subjectKey`), its LATEST statement: a correction (a reply whose verdict changed) replaces it,
 *    a `withdrawn` fact marks it (a click proven to be a link scanner, a retracted bounce). A row is only ever replaced
 *    by a higher `seq` (an overlapping copier during a deploy writes the same rows twice, harmlessly).
 *  - The cursor is persisted (`lib/fleet-cell-store.ts`, key `outreach-facts-cursor`): a deploy resumes, never re-reads.
 *  - Followed every 2 minutes (the feed's own emission cadence), single-flight, after listen. FAIL-LOUD per tick
 *    (logged; the next tick resumes from the last stored cursor).
 *  - The thread fields (`sequence.timezone`, `sequence.openTracking`, instantly-service#1212) and a send's prospect-local
 *    time are copied as served; a fact copied before they existed is re-read once (`FORMAT` below).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { outreachFactCopy } from "../db/schema.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { loadFleetCell, storeFleetCell } from "./fleet-cell-store.js";

const PAGE = 1000;
const TICK_MS = 2 * 60_000;
const FIRST_TICK_MS = 90_000;
/** Bump to re-copy the whole feed from the start (a new copied field). */
const FORMAT = "v1";
const cursorKey = `outreach-facts-cursor:${FORMAT}`;

interface RawFact {
  seq: string;
  type: string;
  subjectKey: string;
  supersedesSeq: string | null;
  occurredAt: string;
  leadEmail: string;
  orgId: string | null;
  campaignId: string | null;
  instantlyCampaignId: string;
  transport: string | null;
  sequence?: { timezone: string | null; openTracking: string } | null;
  send: { step: number | null; localSentAt?: string | null; localWeekday?: string | null } | null;
  click: { step: number | null } | null;
  bounce: { step: number | null } | null;
  open: { step: number | null } | null;
  unsubscribe: { step: number | null } | null;
  reply: { verdict: { kind: string; classification: string | null; automatedAnswer: boolean } | null } | null;
  withdrawal: { withdrawnSeq: string } | null;
}

export type OutreachFactRow = typeof outreachFactCopy.$inferInsert;

/** PURE. One served fact as the row it writes (a withdrawal writes nothing of its own: see {@link applyFacts}). */
export function rowOfFact(f: RawFact): OutreachFactRow {
  const step = f.send?.step ?? f.click?.step ?? f.bounce?.step ?? f.open?.step ?? f.unsubscribe?.step ?? null;
  return {
    subjectKey: f.subjectKey,
    seq: Number(f.seq),
    type: f.type,
    occurredAt: new Date(f.occurredAt),
    orgId: f.orgId,
    campaignId: f.campaignId,
    instantlyCampaignId: f.instantlyCampaignId,
    leadEmail: f.leadEmail.toLowerCase(),
    transport: f.transport,
    step,
    localSentAt: f.send?.localSentAt ?? null,
    localWeekday: f.send?.localWeekday ?? null,
    timezone: f.sequence?.timezone ?? null,
    openTracking: f.sequence?.openTracking ?? null,
    replyKind: f.reply?.verdict?.kind ?? null,
    replyClassification: f.reply?.verdict?.classification ?? null,
    replyAutomated: f.reply?.verdict ? f.reply.verdict.automatedAnswer : null,
    withdrawn: false,
  };
}

async function applyFacts(facts: readonly RawFact[]): Promise<void> {
  const rows = new Map<string, OutreachFactRow>();
  const withdrawals: RawFact[] = [];
  for (const f of facts) {
    if (f.type === "withdrawn") {
      withdrawals.push(f);
      continue;
    }
    rows.set(f.subjectKey, rowOfFact(f)); // later facts in the page win (the feed is in seq order)
  }
  const values = [...rows.values()];
  for (let i = 0; i < values.length; i += 500) {
    await db
      .insert(outreachFactCopy)
      .values(values.slice(i, i + 500))
      .onConflictDoUpdate({
        target: outreachFactCopy.subjectKey,
        set: {
          seq: sql`excluded.seq`,
          type: sql`excluded.type`,
          occurredAt: sql`excluded.occurred_at`,
          orgId: sql`excluded.org_id`,
          campaignId: sql`excluded.campaign_id`,
          instantlyCampaignId: sql`excluded.instantly_campaign_id`,
          leadEmail: sql`excluded.lead_email`,
          transport: sql`excluded.transport`,
          step: sql`excluded.step`,
          localSentAt: sql`excluded.local_sent_at`,
          localWeekday: sql`excluded.local_weekday`,
          timezone: sql`excluded.timezone`,
          openTracking: sql`excluded.open_tracking`,
          replyKind: sql`excluded.reply_kind`,
          replyClassification: sql`excluded.reply_classification`,
          replyAutomated: sql`excluded.reply_automated`,
          withdrawn: sql`false`,
          copiedAt: sql`now()`,
        },
        setWhere: sql`${outreachFactCopy.seq} < excluded.seq`,
      });
  }
  for (const w of withdrawals) {
    await db.execute(sql`UPDATE outreach_fact_copy SET withdrawn = true, seq = ${Number(w.seq)}, copied_at = now() WHERE subject_key = ${w.subjectKey} AND seq < ${Number(w.seq)}`);
  }
}

/** One copy pass: every page from the stored cursor until caught up. Returns how many facts it read. */
export async function copyOutreachFacts(): Promise<number> {
  const base = process.env.INSTANTLY_SERVICE_URL;
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!base || !key) throw new Error("INSTANTLY_SERVICE_URL / INSTANTLY_SERVICE_API_KEY not configured");
  const stored = parseCursor((await loadFleetCell(cursorKey))?.text ?? null);
  let cursor = stored.cursor;
  let withSequence = stored.withSequence;
  let read = 0;
  for (let page = 0; page < 1000; page++) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (cursor) q.set("since", cursor);
    const res = await fetchWithRetry(`${base}/internal/outreach-facts?${q}`, { headers: { "x-api-key": key } }, { timeoutMs: 60_000 });
    if (!res.ok) throw new Error(`instantly-service outreach-facts ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { facts?: RawFact[]; nextCursor?: string; hasMore?: boolean };
    if (!Array.isArray(body.facts) || typeof body.nextCursor !== "string") throw new Error("instantly-service outreach-facts: malformed page");
    // The feed states each thread's timezone and pixel arm since instantly-service#1212, derived at READ time: once it
    // does, everything copied before is re-read once from the start, so no row keeps a missing arm or zone.
    if (!withSequence && body.facts.some((f) => f.sequence !== undefined)) {
      withSequence = true;
      cursor = null;
      await storeFleetCell(cursorKey, JSON.stringify({ cursor, withSequence }), Date.now());
      console.log("[features-service] outreach facts copy: the feed now states thread timezone + pixel arm, re-reading it from the start");
      continue;
    }
    if (body.facts.length) await applyFacts(body.facts);
    read += body.facts.length;
    if (body.nextCursor !== cursor) {
      cursor = body.nextCursor;
      await storeFleetCell(cursorKey, JSON.stringify({ cursor, withSequence }), Date.now());
    }
    if (!body.hasMore) break;
  }
  return read;
}

/** PURE. The stored cursor (`{cursor, withSequence}`; a bare cursor string from before reads `withSequence: false`). */
export function parseCursor(text: string | null): { cursor: string | null; withSequence: boolean } {
  if (!text) return { cursor: null, withSequence: false };
  try {
    const v = JSON.parse(text) as { cursor?: string | null; withSequence?: boolean };
    if (v && typeof v === "object") return { cursor: v.cursor ?? null, withSequence: v.withSequence === true };
  } catch {
    // a bare cursor (digits)
  }
  return { cursor: text, withSequence: false };
}

let running: Promise<void> | null = null;
/** The copier's tick (single-flight per process). */
export function tickOutreachFactsCopy(): Promise<void> {
  if (running) return running;
  running = copyOutreachFacts()
    .then((n) => {
      if (n > 0) console.log(`[features-service] outreach facts copy: ${n} facts copied`);
    })
    .catch((err) => console.error("[features-service] outreach facts copy failed (next tick resumes from the stored cursor):", err))
    .finally(() => {
      running = null;
    });
  return running;
}

export function startOutreachFactsCopy(): void {
  setTimeout(() => {
    void tickOutreachFactsCopy();
    setInterval(() => void tickOutreachFactsCopy(), TICK_MS).unref();
  }, FIRST_TICK_MS).unref();
}
