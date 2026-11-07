import { describe, it, expect } from "vitest";
import { BOARD_RUNG_KEYS, priceLifecycleBoard, priceLifecycleBoardScopes, priceLifecycleColumns, type LifecycleBoardRow } from "./deals-lifecycle.js";
import { contactedExpiryCutoffIso, contactedLeadValue, expectedValueOfPerson, type EnginePerson, type ResolvedPath } from "./revenue-engine.js";
import { LIFECYCLE_RUNGS } from "./lifecycle-ladder.js";

// LTR $1,000. A website visit is worth $100, a positive reply $400, a booked meeting $500, a sale $1,000.
const LTR = 1000;
const PATHS: ResolvedPath[] = [
  { tag: "visit", signal: "clicked", expectedRevenueUsd: 100, engagementRoute: true },
  { tag: "reply", signal: "positiveReply", expectedRevenueUsd: 400, engagementRoute: true },
  { tag: "meeting", signal: "meeting", expectedRevenueUsd: 500 },
  { tag: "closeWin", signal: "closeWin", expectedRevenueUsd: 1000, terminal: true },
];
const NOW = new Date("2026-10-21T12:00:00Z");
const RECENT = "2026-10-19T12:00:00Z";
const OLD = "2026-08-01T12:00:00Z";

function person(leadId: string, orgId: string | null, signals: Record<string, boolean>, extra: Partial<EnginePerson> = {}): EnginePerson {
  return {
    leadId,
    firstName: null,
    lastName: null,
    photoUrl: null,
    orgId,
    orgName: null,
    orgLogoUrl: null,
    orgDomain: null,
    title: null,
    seniority: null,
    orgIndustry: null,
    orgEmployeeCount: null,
    orgCity: null,
    orgCountry: null,
    email: `${leadId}@x.com`,
    campaignId: "camp-1",
    workflowSlug: "wf-1",
    signalDates: { contacted: RECENT, lastSent: RECENT },
    signals: { contacted: true, ...signals },
    ...extra,
  };
}

const PERSONS: EnginePerson[] = [
  person("c-measured", "org-A", {}),
  person("c-default", "org-B", {}, { campaignId: "camp-unpriced" }),
  person("c-expired", "org-C", {}, { signalDates: { contacted: OLD, lastSent: OLD } }),
  person("c-bounced", "org-D", { bounced: true }),
  person("e-reply-1", "org-E", { positiveReply: true }),
  person("e-reply-2", "org-E", { positiveReply: true, clicked: true }),
  person("m-booked", "org-F", { positiveReply: true, meeting: true }),
  person("w-stated", "org-G", { closeWin: true }),
  person("w-ltr", "org-H", { closeWin: true }),
];
const row = (humanId: string, rung: LifecycleBoardRow["rung"], leadIds: string[]): LifecycleBoardRow => ({
  humanId,
  companyKey: "",
  relationKey: `rel:${humanId}`,
  leadIds,
  rung,
});
const ROWS: LifecycleBoardRow[] = [
  row("h-c1", "contacted", ["c-measured"]),
  row("h-c2", "contacted", ["c-default"]),
  row("h-c3", "contacted", ["c-expired"]),
  row("h-c4", "contacted", ["c-bounced"]),
  row("h-e1", "engaged", ["e-reply-1"]),
  row("h-e2", "engaged", ["e-reply-2"]),
  row("h-m", "meeting_booked", ["m-booked"]),
  row("h-w1", "paid_client", ["w-stated"]),
  row("h-w2", "paid_client", ["w-ltr"]),
  // Someone of the brand this scope never served: not on this board.
  row("h-out", "engaged", ["other-offer-lead"]),
];

const args = (over: Partial<Parameters<typeof priceLifecycleColumns>[0]> = {}): Parameters<typeof priceLifecycleColumns>[0] => ({
    // LEDGER-ONLY-1107-P2: the ledger holds 2 Paid client Units (the won column = 2 x LTR); no other rung counted.
    ledgerUnitsOf: (r) => (r === "paid_client" ? { units: 2, ourUnits: 2, otherFactoryUnits: { total: 0, anotherFactory: 0, noProof: 0 }, reason: null } : { units: null, ourUnits: null, otherFactoryUnits: null, reason: "not_a_ledger_outcome" }),
    rows: ROWS,
    persons: PERSONS,
    paths: PATHS,
    lifetimeRevenueUsd: LTR,
    lifetimeRevenueSource: "fleet_median",
    // The pipeline's contacted pricing: camp-1 × wf-1 measured (2.5% reply ⇒ $10), every other group on the default.
    contactedPricing: {
      entryRatePctByGroup: { "camp-1|wf-1": { positiveReply: 2.5 } },
      defaultEntryRatePct: { positiveReply: 1, clicked: 2 },
      lastSentOnOrAfter: contactedExpiryCutoffIso(NOW),
    },
    statedWonAmountUsdByEmail: new Map([["w-stated@x.com", 4900]]),
    pricedCauses: ["outreach", "other", "unstated"],
    ...over,
  });
const run = (over: Partial<Parameters<typeof priceLifecycleColumns>[0]> = {}) => priceLifecycleColumns(args(over));
const rung = (r: ReturnType<typeof run>, key: string) => r.rungs.find((x) => x.key === key)!;
const card = (r: ReturnType<typeof run>, key: string, humanId: string) => rung(r, key).cards.find((c) => c.humanId === humanId)!;

describe("priceLifecycleColumns (DEALS-LIFECYCLE-1021)", () => {
  const r = run();

  it("serves every board rung in ladder order, Lead found left out, an empty rung at 0 (never absent)", () => {
    expect(r.rungs.map((x) => x.key)).toEqual(LIFECYCLE_RUNGS.filter((x) => x.key !== "lead_found").map((x) => x.key));
    expect(r.rungs.map((x) => x.key)).toEqual([...BOARD_RUNG_KEYS]);
    expect(r.rungs.map((x) => x.rank)).toEqual([2, 3, 4, 5, 6, 7]);
    for (const empty of ["signup_or_form", "meeting_attended"]) {
      expect(rung(r, empty).valueUsd).toBe(0);
      expect(rung(r, empty).cards).toEqual([]);
      expect(rung(r, empty).cardCount).toBe(0);
    }
  });

  it("the rung values sum to the served totals", () => {
    const sum = r.rungs.reduce((s, x) => s + x.valueUsd!, 0);
    expect(r.totalUsd).toBeCloseTo(sum, 6);
    expect(r.expectedPipelineUsd! + r.wonUsd!).toBeCloseTo(r.totalUsd!, 6);
    expect(r.wonUsd).toBe(rung(r, "paid_client").valueUsd);
  });

  it("Contacted: the measured contacted value, else the seeded entry benchmark (said), 0 when expired or bounced", () => {
    expect(card(r, "contacted", "h-c1")).toMatchObject({ valueUsd: 10, entryRateSource: "measured", zeroValueReason: null });
    // 1% reply × $400, 2% click × $100, combined as independent shots at one $1,000 close.
    const expected = 1000 * (1 - (1 - 4 / 1000) * (1 - 2 / 1000));
    expect(card(r, "contacted", "h-c2").valueUsd).toBeCloseTo(expected, 6);
    expect(card(r, "contacted", "h-c2").entryRateSource).toBe("default_entry");
    expect(card(r, "contacted", "h-c3")).toMatchObject({ valueUsd: 0, zeroValueReason: "expired" });
    expect(card(r, "contacted", "h-c4")).toMatchObject({ valueUsd: 0, zeroValueReason: "cannot_convert" });
    expect(rung(r, "contacted").valueUsd).toBeCloseTo(10 + expected, 6);
    expect(rung(r, "contacted").assumptions).toEqual([
      { input: "lifetime_revenue", source: "fleet_median" },
      { input: "entry_rate", source: "default_entry" },
      { input: "entry_rate", source: "measured" },
    ]);
    expect(rung(r, "contacted").valueKind).toBe("contacted_expected_value");
  });

  it("Engaged and later: the engine's own value per person, one organisation counted once (MAX)", () => {
    const e1 = expectedValueOfPerson(PERSONS[4], PATHS, LTR);
    const e2 = expectedValueOfPerson(PERSONS[5], PATHS, LTR);
    expect(card(r, "engaged", "h-e1").valueUsd).toBeCloseTo(e1, 6);
    expect(card(r, "engaged", "h-e2").valueUsd).toBeCloseTo(e2, 6);
    expect(rung(r, "engaged").valueUsd).toBeCloseTo(Math.max(e1, e2), 6);
    // LEDGER-ONLY-1107-P2: people / organisations on a rung are no ledger figure.
    expect(rung(r, "engaged").organizationCount).toBeNull();
    expect(rung(r, "engaged").cardCount).toBe(2);
    expect(card(r, "meeting_booked", "h-m").valueUsd).toBe(500);
    expect(rung(r, "engaged").expected).toBe(true);
  });

  it("a row whose leads this scope does not hold is not on the board", () => {
    expect(rung(r, "engaged").cards.map((c) => c.humanId)).toEqual(["h-e1", "h-e2"]);
    expect(r.outOfScopeCardCount).toBe(1);
  });

  it("LEDGER-ONLY-1107-P2: Paid client = the ledger's Paid client Units x LTR; no card carries it", () => {
    expect(card(r, "paid_client", "h-w1")).toMatchObject({ valueUsd: 0, zeroValueReason: "won_counted_on_ledger" });
    expect(card(r, "paid_client", "h-w2")).toMatchObject({ valueUsd: 0, zeroValueReason: "won_counted_on_ledger" });
    expect(rung(r, "paid_client").valueUsd).toBe(2 * LTR);
    expect(rung(r, "paid_client").units).toBe(2);
    expect(r.wonUsd).toBe(2 * LTR);
    // The ledger lacking Paid client Units: rung, won and total unknown, never the CRM's deals.
    const lacks = run({ ledgerUnitsOf: () => ({ units: null, ourUnits: null, otherFactoryUnits: null, reason: "outcome_not_declared_in_ledger" }) });
    expect(rung(lacks, "paid_client").valueUsd).toBeNull();
    expect(rung(lacks, "paid_client").unitsUnavailableReason).toBe("outcome_not_declared_in_ledger");
    expect(lacks.wonUsd).toBeNull();
    expect(lacks.totalUsd).toBeNull();
    expect(lacks.expectedPipelineUsd).not.toBeNull();
    // LEDGER-OTHER-FACTORY-1107: 2 ours + 15 another factory made: the rung counts 17, its value is OUR 2 only.
    const mixed = run({ ledgerUnitsOf: (k) => (k === "paid_client" ? { units: 17, ourUnits: 2, otherFactoryUnits: { total: 15, anotherFactory: 6, noProof: 9 }, reason: null } : { units: null, ourUnits: null, otherFactoryUnits: null, reason: "not_a_ledger_outcome" }) });
    expect(rung(mixed, "paid_client")).toMatchObject({ units: 17, ourUnits: 2, otherFactoryUnits: { total: 15 }, valueUsd: 2 * LTR });
    expect(mixed.wonUsd).toBe(2 * LTR);
  });

  it("a ruled-out engaged person reads 0 ruled_out", () => {
    const res = run({ persons: PERSONS.map((p) => (p.leadId === "e-reply-1" ? { ...p, disqualified: true } : p)) });
    expect(card(res, "engaged", "h-e1")).toMatchObject({ valueUsd: 0, zeroValueReason: "ruled_out" });
  });

  it("no economics: every figure null with the reason, people still listed", () => {
    const res = run({ lifetimeRevenueUsd: null, lifetimeRevenueSource: null });
    expect(res.unvaluedReason).toBe("no_economics");
    expect(res.totalUsd).toBeNull();
    expect(res.rungs.every((x) => x.valueUsd === null)).toBe(true);
    expect(rung(res, "engaged").cardCount).toBe(2);
  });
});

describe("ONE pipeline basis (owner 2026-10-21): the board prices what the pipeline prices", () => {
  it("a rung reached but not caused by our pipes is 0 `not_ours`; a sale not ours adds no won value", () => {
    const persons = [
      person("e-other", "org-X", { positiveReply: true }, { unpricedSignals: ["positiveReply"] }),
      person("w-other", "org-Y", { closeWin: true }, { unpricedSignals: ["closeWin"] }),
    ];
    const r = run({
      persons,
      rows: [row("h-eo", "engaged", ["e-other"]), row("h-wo", "paid_client", ["w-other"])],
    });
    expect(card(r, "engaged", "h-eo")).toMatchObject({ valueUsd: 0, zeroValueReason: "not_ours" });
    expect(card(r, "paid_client", "h-wo")).toMatchObject({ valueUsd: 0, zeroValueReason: "won_counted_on_ledger" });
    expect(r.wonUsd).toBe(2 * LTR);
  });

  it("REVENUE-GENERATED-1107: a Paid client card with no sale of ours (no closeWin, or a dead one) adds no won value", () => {
    // Prod 2026-11-07 (our own offer Product-led): 13 companies on the Paid client rung with no outreach-caused sale
    // read $6,500 won beside realizedReturn's 0 paid clients.
    const persons = [
      person("w-none", "org-N", { positiveReply: true }),
      person("w-dead", "org-D2", { closeWin: true }, { deadSignals: ["closeWin"] }),
      person("w-ours", "org-O", { closeWin: true }),
    ];
    const r = run({
      persons,
      rows: [row("h-n", "paid_client", ["w-none"]), row("h-d", "paid_client", ["w-dead"]), row("h-o", "paid_client", ["w-ours"])],
    });
    // LEDGER-ONLY-1107-P2 supersedes the CRM predicate: whatever the cards, won = the ledger's Units x LTR.
    for (const h of ["h-n", "h-d", "h-o"]) expect(card(r, "paid_client", h)).toMatchObject({ valueUsd: 0, zeroValueReason: "won_counted_on_ledger" });
    expect(r.wonUsd).toBe(2 * LTR);
  });

  it("Contacted rides the pipeline's own function: a lead with no group rate takes the default, none at all ⇒ 0", () => {
    const pricing = {
      entryRatePctByGroup: {},
      defaultEntryRatePct: { positiveReply: 1, clicked: 2 },
      lastSentOnOrAfter: contactedExpiryCutoffIso(NOW),
    };
    const p = person("c-unattributed", "org-Z", {}, { campaignId: null, workflowSlug: null });
    expect(contactedLeadValue(p, PATHS, LTR, pricing)).toBeCloseTo(1000 * (1 - (1 - 4 / 1000) * (1 - 2 / 1000)), 6);
    expect(contactedLeadValue(p, PATHS, LTR, { ...pricing, defaultEntryRatePct: undefined })).toBe(0);
  });
});

describe("a rung lead-service places further along than the engine sees: the pipeline's own value", () => {
  it("an Engaged card whose person has no priced step yet is worth its contacted value, as in the pipeline", () => {
    const p = person("e-contacted-only", "org-Q", {}, { campaignId: "camp-unpriced" });
    const r = run({ persons: [p], rows: [row("h-eq", "engaged", ["e-contacted-only"])] });
    const expected = 1000 * (1 - (1 - 4 / 1000) * (1 - 2 / 1000)); // the seeded default entry, reply + click
    expect(card(r, "engaged", "h-eq").valueUsd).toBeCloseTo(expected, 6);
    expect(card(r, "engaged", "h-eq").zeroValueReason).toBeNull();
  });
});

describe("one organisation = one client ACROSS the pipeline rungs (the revenue read's MAX over members)", () => {
  it("a company with a colleague on Contacted and one on Engaged counts once, on the most valuable member's rung", () => {
    // 2026-10-21 prod: karriere.at stood on Contacted ($0.26) AND Engaged ($0.36); the board summed both.
    const contacted = person("k-contacted", "org-K", {});
    const engaged = person("k-engaged", "org-K", { positiveReply: true });
    const r = run({
      persons: [contacted, engaged],
      rows: [row("h-kc", "contacted", ["k-contacted"]), row("h-ke", "engaged", ["k-engaged"])],
    });
    const vc = card(r, "contacted", "h-kc").valueUsd!;
    const ve = card(r, "engaged", "h-ke").valueUsd!;
    expect(vc).toBeGreaterThan(0);
    expect(ve).toBeGreaterThan(vc);
    // Cards keep their own value; the colleague adds 0 to its rung.
    expect(rung(r, "contacted").valueUsd).toBe(0);
    expect(rung(r, "engaged").valueUsd).toBeCloseTo(ve, 6);
    expect(r.expectedPipelineUsd).toBeCloseTo(Math.max(vc, ve), 6);
    expect(rung(r, "contacted").organizationCount).toBeNull();
  });

  it("a tie lands on the higher rung; different companies still add up", () => {
    const a = person("t-low", "org-T", {});
    const b = person("t-high", "org-T", {});
    const c = person("u-1", "org-U", {});
    const r = run({
      persons: [a, b, c],
      rows: [row("h-tl", "contacted", ["t-low"]), row("h-th", "engaged", ["t-high"]), row("h-u", "contacted", ["u-1"])],
    });
    const v = card(r, "contacted", "h-u").valueUsd!;
    expect(rung(r, "engaged").valueUsd).toBeCloseTo(v, 6);
    expect(rung(r, "contacted").valueUsd).toBeCloseTo(v, 6);
    expect(r.expectedPipelineUsd).toBeCloseTo(2 * v, 6);
  });
});

describe("priceLifecycleBoard organisation values (PIPELINE-GENERATED-1107)", () => {
  it("what each organisation adds sums to the board's total, each organisation once", () => {
    const { board, organizationValues } = priceLifecycleBoard(args());
    expect(board).toEqual(run());
    // The won dollars are the ledger's (no organisation carries them): the organisations add up to the open pipeline.
    const sum = [...organizationValues.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(board.expectedPipelineUsd!, 4);
    // org-E has two engaged people: one organisation, counted once at its most valuable member.
    expect(organizationValues.get("org:org-E")).toBeCloseTo(Math.max(card(board, "engaged", "h-e1").valueUsd!, card(board, "engaged", "h-e2").valueUsd!), 6);
    expect(organizationValues.get("org:org-G")).toBeUndefined();
  });
  it("no economics: no organisation value", () => {
    expect(priceLifecycleBoard(args({ lifetimeRevenueUsd: null })).organizationValues.size).toBe(0);
  });
});

describe("priceLifecycleBoardScopes (BRAND-GRAIN-READS-1107: a brand board over every offer)", () => {
  const scopesArgs = (scopes: Parameters<typeof priceLifecycleBoardScopes>[0]["scopes"], wonUsd?: number | null) => {
    const { persons: _p, paths: _a, lifetimeRevenueUsd: _l, lifetimeRevenueSource: _s, ...rest } = args();
    return priceLifecycleBoardScopes({ ...rest, scopes, ...(wonUsd !== undefined ? { wonUsd } : {}) }).board;
  };
  const half = (from: number, to: number) => PERSONS.slice(from, to);

  it("one scope = the offer board, byte for byte", () => {
    expect(scopesArgs([{ persons: PERSONS, paths: PATHS, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" }])).toEqual(run());
  });

  it("two offers with the same terms, people split between them = the one-offer board on everyone", () => {
    const two = scopesArgs([
      { persons: half(0, 5), paths: PATHS, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" },
      { persons: half(5, PERSONS.length), paths: PATHS, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" },
    ]);
    expect(two).toEqual(run());
  });

  it("a person two offers served is ONE card at its MAX, and its organisation counts once", () => {
    const cheap: ResolvedPath[] = PATHS.map((p) => ({ ...p, expectedRevenueUsd: p.expectedRevenueUsd / 10 }));
    const both = scopesArgs([
      { persons: PERSONS, paths: cheap, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" },
      { persons: PERSONS, paths: PATHS, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" },
    ]);
    expect(card(both, "engaged", "h-e1").leadIds).toEqual(["e-reply-1"]);
    expect(card(both, "engaged", "h-e1").valueUsd).toBe(card(run(), "engaged", "h-e1").valueUsd);
    expect(both.expectedPipelineUsd).toBe(run().expectedPipelineUsd);
  });

  it("offers stating different lifetime revenues: no single LTR, the won column is the caller's per-offer sum", () => {
    const b = scopesArgs(
      [
        { persons: half(0, 5), paths: PATHS, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" },
        { persons: half(5, PERSONS.length), paths: PATHS, lifetimeRevenueUsd: 2 * LTR, lifetimeRevenueSource: "offer_stated" },
      ],
      3000,
    );
    expect(b.lifetimeRevenueUsd).toBeNull();
    expect(b.lifetimeRevenueSource).toBeNull();
    expect(b.unvaluedReason).toBeNull();
    expect(rung(b, "paid_client").valueUsd).toBe(3000);
    expect(b.totalUsd).toBe(b.expectedPipelineUsd! + 3000);
    // The scope with no economics prices nobody; a valued one still serves the board.
    const partial = scopesArgs(
      [
        { persons: half(0, 5), paths: PATHS, lifetimeRevenueUsd: LTR, lifetimeRevenueSource: "fleet_median" },
        { persons: half(5, PERSONS.length), paths: [], lifetimeRevenueUsd: null, lifetimeRevenueSource: null },
      ],
      null,
    );
    expect(partial.unvaluedReason).toBeNull();
    expect(card(partial, "meeting_booked", "h-m").valueUsd).toBeNull();
    expect(partial.wonUsd).toBeNull();
    expect(scopesArgs([{ persons: PERSONS, paths: [], lifetimeRevenueUsd: null, lifetimeRevenueSource: null }]).unvaluedReason).toBe("no_economics");
  });
});
