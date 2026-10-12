import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

const { buildPipeTeamImpact, impactOf } = await import("./pipe-team-impact.js");
const { ourLeadsToTeamFigures } = await import("./team-on-our-leads.js");

const dated = (byDay: Record<string, number>, undated = 0) => ({ daily: new Map(Object.entries(byDay)), undated });
const labels = { teamChannelSlugs: ["your-team-meeting-booking"], fromStepLabel: "Positive reply", toStepLabel: "Meeting booked" };

describe("team alone vs team + this pipe (owner 2026-10-12)", () => {
  // Doc Dinners: 24 replies left to their team -> 4 meetings; 8 our AI acted on -> 2 meetings, $3.52 spent.
  const team = { from: dated({ "2026-10-01": 20 }, 4), to: dated({ "2026-10-03": 4 }) };
  const pipe = { from: dated({ "2026-10-01": 6, "2026-10-02": 2 }), to: dated({ "2026-10-02": 1, "2026-10-04": 1 }) };
  const spendByDay = new Map([["2026-10-01", 2], ["2026-10-04", 1.52]]);
  const b = buildPipeTeamImpact({ ...labels, reason: null, team, pipe, spendByDay, today: "2026-10-05" });

  it("serves the two rows, the impact in points and ratio", () => {
    expect(b.available).toBe(true);
    expect(b.rows[0]).toMatchObject({ key: "team_alone", fromCount: 24, toCount: 4, ratePct: 16.67, undatedFrom: 4, spendUsd: null, costPerOutcomeUsd: null, costPerOutcomeUnavailableReason: "customer_team_time" });
    expect(b.rows[1]).toMatchObject({ key: "team_plus_pipe", fromCount: 8, toCount: 2, ratePct: 25, spendUsd: 3.52, costPerOutcomeUsd: 1.76, costPerOutcomeUnavailableReason: null });
    expect(b.impact).toEqual({ pointsDiff: 8.33, pointsDiffUnavailableReason: null, ratio: 1.5, ratioUnavailableReason: null });
  });

  it("history is cumulative per day; the last point IS the snapshot (undated enter there)", () => {
    expect(b.history.map((h) => h.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(b.history[0]).toMatchObject({ teamAlone: { fromCount: 20, toCount: 0, ratePct: 0 }, teamPlusPipe: { fromCount: 6, toCount: 0, ratePct: 0, spendUsd: 2, costPerOutcomeUsd: null }, impact: { pointsDiff: 0, ratio: null } });
    expect(b.history[2]).toMatchObject({ teamAlone: { fromCount: 20, toCount: 4, ratePct: 20 }, teamPlusPipe: { fromCount: 8, toCount: 1, ratePct: 12.5, costPerOutcomeUsd: 2 } });
    const last = b.history.at(-1)!;
    expect(last.teamAlone).toEqual({ fromCount: b.rows[0].fromCount, toCount: b.rows[0].toCount, ratePct: b.rows[0].ratePct });
    expect(last.teamPlusPipe).toEqual({ fromCount: 8, toCount: 2, ratePct: 25, spendUsd: 3.52, costPerOutcomeUsd: 1.76 });
    expect(last.impact).toEqual({ pointsDiff: b.impact.pointsDiff, ratio: b.impact.ratio });
  });

  it("unmeasured = null + reason, never 0; a 0 team rate keeps the points but not the ratio", () => {
    const none = buildPipeTeamImpact({ ...labels, reason: "no_campaign_of_ours_brings_people_to_from", team: null, pipe: null, spendByDay: new Map(), today: "2026-10-05" });
    expect(none).toMatchObject({ available: false, unavailableReason: "no_campaign_of_ours_brings_people_to_from", history: [] });
    expect(none.rows.map((r) => [r.fromCount, r.toCount, r.ratePct, r.rateUnavailableReason])).toEqual([
      [null, null, null, "no_campaign_of_ours_brings_people_to_from"],
      [null, null, null, "no_campaign_of_ours_brings_people_to_from"],
    ]);
    expect(none.impact).toMatchObject({ pointsDiff: null, pointsDiffUnavailableReason: "team_alone_not_measured" });
    expect(impactOf(0, null, 5, 20)).toMatchObject({ pointsDiff: null, pointsDiffUnavailableReason: "team_alone_no_input" });
    expect(impactOf(5, 20, 0, null)).toMatchObject({ pointsDiff: null, pointsDiffUnavailableReason: "team_plus_pipe_no_input" });
    expect(impactOf(5, 0, 4, 25)).toEqual({ pointsDiff: 25, pointsDiffUnavailableReason: null, ratio: null, ratioUnavailableReason: "team_alone_rate_zero" });
    const empty = buildPipeTeamImpact({ ...labels, reason: null, team: { from: dated({}), to: dated({}) }, pipe: { from: dated({}), to: dated({}) }, spendByDay: new Map(), today: "2026-10-05" });
    expect(empty.rows[1]).toMatchObject({ fromCount: 0, ratePct: null, rateUnavailableReason: "no_input_yet", costPerOutcomeUnavailableReason: "no_outcome_yet" });
  });

  it("the focus pipe's people: those its in-scope campaigns acted on, dated by their `from` day, same outcome rule", () => {
    const f = ourLeadsToTeamFigures({
      brought: [
        { leadId: "a", fromAt: "2026-10-01T10:00:00Z" },
        { leadId: "b", fromAt: "2026-10-02T10:00:00Z" },
        { leadId: "c", fromAt: "2026-10-02T10:00:00Z" },
      ],
      acted: new Map([["a", "2026-10-01T11:00:00Z"], ["b", "2026-10-02T11:00:00Z"], ["x", "2026-10-03T11:00:00Z"]]),
      actedInScope: new Set(["a", "b", "x"]),
      toAtByLead: new Map([["a", ["2026-10-04T00:00:00Z"]], ["b", ["2026-09-01T00:00:00Z"]], ["x", [null]]]),
      // b acted on by another pipe of ours on the leg: not this pipe's.
      focusActedInScope: new Set(["a", "x"]),
    });
    expect([...f.focusActed.daily]).toEqual([["2026-10-01", 1], ["2026-10-03", 1]]);
    expect(f.focusActed.undated).toBe(0);
    expect([...f.focusReached.daily]).toEqual([["2026-10-04", 1]]);
    expect(f.focusReached.undated).toBe(1);
    // Team alone = c only.
    expect([...f.left.daily]).toEqual([["2026-10-02", 1]]);
  });
});
