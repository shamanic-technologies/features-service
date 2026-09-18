import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../db/index.js", () => ({
  db: { query: { features: { findFirst: vi.fn(), findMany: vi.fn() } } },
  sql: {},
}));
vi.mock("../lib/env.js", () => ({ validateRequiredEnv: vi.fn(), REQUIRED_ENV: [] }));
vi.mock("../instrument.js", () => ({}));
vi.mock("@sentry/node", () => ({
  default: { setupExpressErrorHandler: vi.fn() },
  setupExpressErrorHandler: vi.fn(),
}));
// The pair-economics read fans out cross-org; its dataset is irrelevant here — an empty one answers
// `no_spend_recorded` for every pair, which still carries the commercial term on every row.
vi.mock("../lib/cross-org-cost-per-outcome.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchFunnelBucketDataset: vi.fn(async () => []),
}));
// Every funnel in the real map adds nothing to its channel, so the FUNNEL-governs branch could not be
// exercised end to end without one. This states a conversation funnel that genuinely needs 60 days —
// longer than one of the two channels below and shorter than the other — so a SINGLE fixture drives
// both verdicts and the composition can be seen to be a property of the PAIR, not of the funnel.
// `composeMinimumCommitment` stays REAL: what is under test is the composition, not the map.
vi.mock("../lib/funnel-commercial-terms.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  minimumCommitmentDaysFor: (key: string) => (key === "sales_meetings_from_conversation" ? 60 : null),
}));

process.env.FEATURES_SERVICE_API_KEY = "test-key";
process.env.FEATURES_SERVICE_DATABASE_URL = "postgres://fake:5432/test";
process.env.NODE_ENV = "test";
process.env.FEATURE_VIEW_CACHE_ENABLED = "false";

const { db } = await import("../db/index.js");
const app = (await import("../index.js")).default;
const { __resetChannelCatalogueCache } = await import("./public.js");

const CONVERSATION = "sales_meetings_from_conversation";
// Every other funnel a conversation or a website visit enters. The two AD funnels are absent because
// neither of these channels delivers their first step, which is the join doing its job.
const OTHER_FUNNELS = ["sales_meetings_from_website", "website_purchases", "form_magnet", "sales_from_conversation", "sales_from_website"];

const FAST_CHANNEL = "fast-cold-email-outreach";
const SLOW_CHANNEL = "slow-seo-outreach";

/** Two channels selling the SAME funnels, differing only in how long each must run. */
const channelBlob = (minimumCommitmentDays: number) => ({
  family: "outbound_one_to_one",
  operatedBy: "platform",
  stepTransitions: [{ from: null, to: "conversation" }, { from: null, to: "website_visit" }],
  terms: { dailyOperatingCostCents: 800, minimumCommitmentDays, maxDaysToFirstProduction: 14 },
});

const FEATURE_ROW = (slug: string, minimumCommitmentDays: number) => ({
  id: `feat-${slug}`,
  slug,
  name: slug,
  description: "x",
  status: "active",
  acquisitionChannel: channelBlob(minimumCommitmentDays),
  outputs: [],
  charts: [],
  entities: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

const ROWS = [FEATURE_ROW(FAST_CHANNEL, 30), FEATURE_ROW(SLOW_CHANNEL, 90)];

interface FunnelEntry {
  key: string;
  funnelMinimumCommitmentDays: number | null;
  effectiveMinimumCommitmentDays: number;
  governedBy: "channel" | "funnel";
}

interface PairRow extends FunnelEntry {
  channelSlug: string;
  funnelKey: string;
  result: { measured: boolean };
}

const mockRows = () =>
  vi.mocked(db.query.features.findMany).mockImplementation((async () => ROWS) as never);

beforeEach(() => {
  vi.mocked(db.query.features.findMany).mockReset();
  __resetChannelCatalogueCache();
});

describe("the public catalogue states ONE composed minimum run length per pair", () => {
  it("GET /public/channels — the funnel governs on the fast channel and the channel governs on the slow one", async () => {
    mockRows();
    const res = await request(app).get("/public/channels");
    expect(res.status).toBe(200);

    const bySlug = new Map<string, { terms: { minimumCommitmentDays: number }; salesFunnels: FunnelEntry[] }>(
      (res.body.channels as Array<{ slug: string; terms: { minimumCommitmentDays: number }; salesFunnels: FunnelEntry[] }>)
        .map((c) => [c.slug, c]),
    );

    const fast = bySlug.get(FAST_CHANNEL)!.salesFunnels.find((f) => f.key === CONVERSATION)!;
    const slow = bySlug.get(SLOW_CHANNEL)!.salesFunnels.find((f) => f.key === CONVERSATION)!;

    // SAME funnel, SAME stated 60 days, two different answers — the figure is a property of the PAIR.
    expect(fast.funnelMinimumCommitmentDays).toBe(60);
    expect(slow.funnelMinimumCommitmentDays).toBe(60);
    expect(fast.effectiveMinimumCommitmentDays).toBe(60);
    expect(fast.governedBy).toBe("funnel");
    expect(slow.effectiveMinimumCommitmentDays).toBe(90);
    expect(slow.governedBy).toBe("channel");

    // A funnel adding nothing takes its channel's figure on both.
    for (const key of OTHER_FUNNELS) {
      const onFast = bySlug.get(FAST_CHANNEL)!.salesFunnels.find((f) => f.key === key)!;
      const onSlow = bySlug.get(SLOW_CHANNEL)!.salesFunnels.find((f) => f.key === key)!;
      expect([onFast.funnelMinimumCommitmentDays, onFast.effectiveMinimumCommitmentDays, onFast.governedBy]).toEqual([null, 30, "channel"]);
      expect([onSlow.funnelMinimumCommitmentDays, onSlow.effectiveMinimumCommitmentDays, onSlow.governedBy]).toEqual([null, 90, "channel"]);
    }

    // The CHANNEL's own term is untouched — the admin model page is its only reader.
    expect(bySlug.get(FAST_CHANNEL)!.terms.minimumCommitmentDays).toBe(30);
    expect(bySlug.get(SLOW_CHANNEL)!.terms.minimumCommitmentDays).toBe(90);
  });

  it("GET /public/channels — publishes EVERY declared funnel, each naming the step it starts on", async () => {
    // AC: the catalogue publishes all eight funnels with brand-service's own names and chains, and a
    // consumer answers "which funnels does this outcome lead into" from THIS payload alone.
    mockRows();
    const res = await request(app).get("/public/channels");
    expect(res.status).toBe(200);

    const funnels = res.body.funnels as Array<{
      key: string;
      name: string;
      steps: string[];
      entryStep: { key: string; label: string };
      entryLegKey: string;
    }>;
    expect(funnels.map((f) => f.key)).toEqual([
      "sales_meetings_from_conversation",
      "sales_meetings_from_website",
      "website_purchases",
      "form_magnet",
      "sales_from_conversation",
      "sales_meetings_from_ads",
      "lead_forms_from_ads",
      "sales_from_website",
    ]);
    // brand-service's OWN names, including the two that MOVED on funnels we already mirrored.
    expect(funnels.find((f) => f.key === "sales_meetings_from_conversation")!.name).toBe("Sales Meeting from Positive Reply");
    expect(funnels.find((f) => f.key === "website_purchases")!.name).toBe("Signups");
    expect(funnels.find((f) => f.key === "sales_from_website")!.name).toBe("Website Purchase");
    // …and no customer-facing name says "conversation".
    for (const funnel of funnels) expect(funnel.name.toLowerCase(), funnel.key).not.toContain("conversation");

    // THE JOIN, done the way a consumer would do it — a token match, no translation table.
    const startedBy = (stepKey: string) => funnels.filter((f) => f.entryStep.key === stepKey).map((f) => f.key);
    expect(startedBy("form_submitted")).toEqual(["lead_forms_from_ads"]);
    expect(startedBy("meeting_booked")).toEqual(["sales_meetings_from_ads"]);
    expect(startedBy("conversation")).toEqual(["sales_meetings_from_conversation", "sales_from_conversation"]);

    // Every produced step of every published channel starts at least one funnel that channel sells —
    // no channel publishes a production that leads nowhere.
    for (const channel of res.body.channels as Array<{ slug: string; producibleSteps: Array<{ key: string }>; salesFunnels: Array<{ key: string }> }>) {
      const sold = new Set(channel.salesFunnels.map((f) => f.key));
      for (const produced of channel.producibleSteps) {
        expect(startedBy(produced.key), `${channel.slug} → ${produced.key}`).not.toEqual([]);
        expect(
          startedBy(produced.key).some((key) => sold.has(key)),
          `${channel.slug} produces ${produced.key} but sells none of the funnels it starts`,
        ).toBe(true);
      }
    }

    // The entry LEG key is served too, so the same join can be keyed on the leg vocabulary.
    const legKeys = new Set((res.body.legs as Array<{ legKey: string }>).map((l) => l.legKey));
    for (const funnel of funnels) {
      expect(funnel.entryLegKey, funnel.key).toBe(`start_to_${funnel.entryStep.key}`);
      expect(legKeys.has(funnel.entryLegKey), funnel.key).toBe(true);
    }
  });

  it("GET /public/channels — publishes the PURCHASE step, and the website-purchase funnel's three rungs", async () => {
    // AC, read exactly as a consumer reads it: the step vocabulary carries the purchase, the funnel
    // that goes to the sale has it in the MIDDLE, and both its arrows are in the leg vocabulary.
    mockRows();
    const res = await request(app).get("/public/channels");
    expect(res.status).toBe(200);

    const steps = res.body.steps as Array<{ key: string; label: string; description: string }>;
    const purchase = steps.find((s) => s.key === "purchase");
    expect(purchase).toBeDefined();
    expect(purchase!.label).toBe("Direct purchase");
    // It is its own rung, not the sale under a second name — asserted as a DIVERGENCE, so a suite
    // that only checked "a step came back" would pass on an implementation that aliased the two.
    const paid = steps.find((s) => s.key === "paid_client")!;
    expect(purchase!.label).not.toBe(paid.label);
    expect(purchase!.description).not.toBe(paid.description);

    const funnels = res.body.funnels as Array<{ key: string; steps: string[]; entryStep: { key: string } }>;
    const web = funnels.find((f) => f.key === "sales_from_website")!;
    expect(web.steps).toEqual(["Website visit", "Direct purchase", "Paid client"]);
    // Still ENTERED on a website visit, which is what keeps every channel producing one selling it.
    expect(web.entryStep.key).toBe("website_visit");

    const legKeys = new Set((res.body.legs as Array<{ legKey: string }>).map((l) => l.legKey));
    expect(legKeys.has("website_visit_to_purchase")).toBe(true);
    expect(legKeys.has("purchase_to_paid_client")).toBe(true);
    // ...and the single leg it replaced is gone rather than published beside them.
    expect(legKeys.has("website_visit_to_paid_client")).toBe(false);

    const byLeg = new Map((res.body.legs as Array<{ legKey: string; funnelKeys: string[] }>).map((l) => [l.legKey, l]));
    expect(byLeg.get("website_visit_to_purchase")!.funnelKeys).toEqual(["sales_from_website"]);
    expect(byLeg.get("purchase_to_paid_client")!.funnelKeys).toEqual(["sales_from_website"]);

    // NO OTHER FUNNEL MOVED — the remaining seven keep the chains they published before.
    const chainOf = (key: string) => funnels.find((f) => f.key === key)!.steps;
    expect(chainOf("website_purchases")).toEqual(["Website visit", "Signup", "Paid client"]);
    expect(chainOf("form_magnet")).toEqual(["Website visit", "Form submitted", "Paid client"]);
    expect(chainOf("sales_from_conversation")).toEqual(["Positive reply", "Paid client"]);
    expect(chainOf("sales_meetings_from_conversation")).toEqual(["Positive reply", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(chainOf("sales_meetings_from_website")).toEqual(["Website visit", "Meeting booked", "Meeting attended", "Paid client"]);
    expect(chainOf("sales_meetings_from_ads")).toEqual(["Meeting booked", "Meeting attended", "Paid client"]);
    expect(chainOf("lead_forms_from_ads")).toEqual(["Form submitted", "Paid client"]);

    // The channel that sells it STILL sells it — the AC's third clause, read off the payload.
    const channels = res.body.channels as Array<{ slug: string; salesFunnels: Array<{ key: string }> }>;
    const sellers = channels.filter((c) => c.salesFunnels.some((f) => f.key === "sales_from_website"));
    expect(sellers.length).toBeGreaterThan(0);
    expect(sellers.map((c) => c.slug)).toContain(FAST_CHANNEL);
  });

  it("GET /public/channels — the bare `minimumCommitmentDays` is GONE from every funnel entry", async () => {
    mockRows();
    const res = await request(app).get("/public/channels");
    expect(res.status).toBe(200);
    for (const channel of res.body.channels as Array<{ salesFunnels: Record<string, unknown>[] }>) {
      for (const funnel of channel.salesFunnels) {
        // Two grains under one word on one payload: the channel's term and the funnel's own.
        expect(Object.keys(funnel)).not.toContain("minimumCommitmentDays");
      }
    }
  });

  it("GET /public/channel-funnel-economics — every pair row states the SAME three fields as its catalogue entry", async () => {
    mockRows();
    const catalogue = await request(app).get("/public/channels");
    __resetChannelCatalogueCache();
    mockRows();
    const pairs = await request(app).get("/public/channel-funnel-economics");
    expect(pairs.status).toBe(200);

    const entryOf = new Map<string, FunnelEntry>();
    for (const channel of catalogue.body.channels as Array<{ slug: string; salesFunnels: FunnelEntry[] }>) {
      for (const funnel of channel.salesFunnels) entryOf.set(`${channel.slug}::${funnel.key}`, funnel);
    }

    const rows = pairs.body.pairs as PairRow[];
    // One row per (channel × funnel it sells) — derived rather than pinned, so a funnel added to the
    // catalogue widens both sides of this check together instead of failing it.
    expect(rows).toHaveLength(entryOf.size);
    expect(rows.length).toBe(2 * (OTHER_FUNNELS.length + 1));
    for (const row of rows) {
      const entry = entryOf.get(`${row.channelSlug}::${row.funnelKey}`)!;
      expect(entry, `${row.channelSlug}::${row.funnelKey}`).toBeDefined();
      expect({
        funnelMinimumCommitmentDays: row.funnelMinimumCommitmentDays,
        effectiveMinimumCommitmentDays: row.effectiveMinimumCommitmentDays,
        governedBy: row.governedBy,
      }).toEqual({
        funnelMinimumCommitmentDays: entry.funnelMinimumCommitmentDays,
        effectiveMinimumCommitmentDays: entry.effectiveMinimumCommitmentDays,
        governedBy: entry.governedBy,
      });
    }

    // The two verdicts survive to the pair grain, and an UNMEASURED pair still states the term.
    const fast = rows.find((r) => r.channelSlug === FAST_CHANNEL && r.funnelKey === CONVERSATION)!;
    const slow = rows.find((r) => r.channelSlug === SLOW_CHANNEL && r.funnelKey === CONVERSATION)!;
    expect([fast.effectiveMinimumCommitmentDays, fast.governedBy]).toEqual([60, "funnel"]);
    expect([slow.effectiveMinimumCommitmentDays, slow.governedBy]).toEqual([90, "channel"]);
    expect(rows.every((r) => r.result.measured === false)).toBe(true);
    expect(rows.every((r) => !("minimumCommitmentDays" in r))).toBe(true);
  });

  it("no published pair promises an answer before the channel can produce one", async () => {
    mockRows();
    const res = await request(app).get("/public/channels");
    expect(res.status).toBe(200);
    // Holds BY CONSTRUCTION — the composition only ever raises the channel's own figure, which the seed
    // already guards against `maxDaysToFirstProduction`. Pinned so a future composition that could
    // LOWER it (a `min`, a funnel override) cannot ship quietly.
    for (const channel of res.body.channels as Array<{ terms: { maxDaysToFirstProduction: number }; salesFunnels: FunnelEntry[] }>) {
      for (const funnel of channel.salesFunnels) {
        expect(funnel.effectiveMinimumCommitmentDays).toBeGreaterThanOrEqual(channel.terms.maxDaysToFirstProduction);
      }
    }
  });
});
