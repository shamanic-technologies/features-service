import { describe, expect, it } from "vitest";
import { buildSpendChartDays, foldSpendActions, spendActionOf, type ChartPerson, type TaskSpendRow } from "./spend-charts.js";

const person = (enteredOn: string | null, convertedOn: string | null | undefined): ChartPerson => ({
  entered: true,
  enteredOn,
  converted: convertedOn !== undefined,
  convertedOn: convertedOn ?? null,
});

describe("spend charts: conversion by ENTRY cohort", () => {
  it("counts a reply 5 days after the send on the SEND day, and only once it happened", () => {
    const days = buildSpendChartDays({
      spendByDay: new Map([["2026-10-01", 10]]),
      taskRows: null,
      persons: [person("2026-10-01", "2026-10-06"), person("2026-10-01", undefined)],
      durationDays: 21,
      outcomesRequired: 1,
      today: "2026-10-08",
    });
    const oct1 = days.find((d) => d.date === "2026-10-01")!;
    // The cohort of Oct 1: 2 entered, 1 converted by today (the reply of Oct 6 is credited to Oct 1).
    expect(oct1.entered).toBe(2);
    expect(oct1.cohortOutcomes).toBe(1);
    expect(oct1.cohortConversionPct).toBe(50);
    // As of Oct 1 itself nobody had replied yet: the as-of conversion is a measured 0, drawn.
    expect(oct1.conversionRatePct).toBe(0);
    expect(days.find((d) => d.date === "2026-10-05")!.conversionRatePct).toBe(0);
    expect(days.find((d) => d.date === "2026-10-06")!.conversionRatePct).toBe(50);
    // Nobody entered on Oct 6: the reply does not open a cohort there.
    expect(days.find((d) => d.date === "2026-10-06")!.entered).toBe(0);
  });

  it("flags a cohort younger than the leg's maturity duration, never drops it", () => {
    const days = buildSpendChartDays({
      spendByDay: new Map([["2026-10-01", 1], ["2026-10-20", 1]]),
      taskRows: null,
      persons: [person("2026-10-01", "2026-10-02"), person("2026-10-20", undefined)],
      durationDays: 21,
      outcomesRequired: 1,
      today: "2026-10-25",
    });
    expect(days.find((d) => d.date === "2026-10-01")!.cohortMature).toBe(true);
    expect(days.find((d) => d.date === "2026-10-20")!.cohortMature).toBe(false);
    const last = days.at(-1)!;
    // 2 entered, 1 converted overall; only the Oct 1 cohort was mature on Oct 25.
    expect(last.conversionRatePct).toBe(50);
    expect(last.matureConversionRatePct).toBe(100);
  });

  it("places undated entrants and outcomes on the LAST point only, never back-dated", () => {
    const days = buildSpendChartDays({
      spendByDay: new Map([["2026-10-01", 30]]),
      taskRows: null,
      persons: [person(null, null), person("2026-10-01", "2026-10-02")],
      durationDays: 0,
      outcomesRequired: 10,
      today: "2026-10-03",
    });
    expect(days.map((d) => d.cumulativeOutcomes)).toEqual([0, 1, 2]);
    expect(days.map((d) => d.cumulativeEntered)).toEqual([1, 1, 2]);
    expect(days.at(-1)!.costPerOutcomeUsd).toBe(15);
  });
});

describe("spend charts: Learning never hides the measured figure (owner 2026-10-19)", () => {
  it("serves the measured cost per outcome on every Learning day once an outcome exists", () => {
    const days = buildSpendChartDays({
      spendByDay: new Map([["2026-10-01", 20], ["2026-10-02", 20]]),
      taskRows: null,
      persons: [person("2026-10-01", "2026-10-02")],
      durationDays: 0,
      outcomesRequired: 10,
      today: "2026-10-03",
    });
    const oct2 = days.find((d) => d.date === "2026-10-02")!;
    expect(oct2.learning).toBe(true);
    expect(oct2.costPerOutcomeUsd).toBe(40);
    expect(days.at(-1)!.learning).toBe(true);
    expect(days.at(-1)!.costPerOutcomeUsd).toBe(40);
    // Before any outcome there is nothing to divide by: null, never 0.
    expect(days[0].costPerOutcomeUsd).toBeNull();
  });

  it("leaves Learning once MATURE outcomes reach the leg's bar", () => {
    const days = buildSpendChartDays({
      spendByDay: new Map([["2026-10-01", 5]]),
      taskRows: null,
      persons: [person("2026-10-01", "2026-10-03")],
      durationDays: 2,
      outcomesRequired: 1,
      today: "2026-10-04",
    });
    // Oct 3: the reply landed but the Oct 1 cohort is mature (Oct 1 <= Oct 3 - 2): bar of 1 reached.
    expect(days.find((d) => d.date === "2026-10-02")!.learning).toBe(true);
    expect(days.find((d) => d.date === "2026-10-03")!.learning).toBe(false);
  });
});

describe("spend charts: what a day's spend bought", () => {
  it("classifies every channel's runs by action, never by vendor", () => {
    expect(spendActionOf("instantly-service", "email-send-step-1")).toBe("first_contacts");
    expect(spendActionOf("instantly-service", "email-send-step-3")).toBe("follow_ups");
    expect(spendActionOf("twilio-service", "place-call")).toBe("first_contacts");
    expect(spendActionOf("lead-service", "lead-serve")).toBe("prospects_found");
    expect(spendActionOf("apollo-service", "verify-email-bounceban")).toBe("prospects_found");
    expect(spendActionOf("chat-service", "complete")).toBe("messages_written");
    expect(spendActionOf("chat-service", "judgments")).toBe("replies_read");
    expect(spendActionOf("postmark-service", "email-send")).toBe("notifications");
    expect(spendActionOf("social-service", "social-post-publish")).toBe("other");
  });

  it("counts the act, prices each action, and adds up to the day's spend", () => {
    const rows: TaskSpendRow[] = [
      { date: "2026-10-19", serviceName: "lead-service", taskName: "lead-serve", spendUsd: 2.27, runs: 81 },
      { date: "2026-10-19", serviceName: "apollo-service", taskName: "verify-email", spendUsd: 0.5, runs: 40 },
      { date: "2026-10-19", serviceName: "instantly-service", taskName: "email-send-step-2", spendUsd: 1.99, runs: 35 },
      { date: "2026-10-19", serviceName: "instantly-service", taskName: "email-send-step-3", spendUsd: 1.99, runs: 35 },
      { date: "2026-10-19", serviceName: "chat-service", taskName: "complete", spendUsd: 3, runs: 300 },
    ];
    const fold = foldSpendActions(rows);
    const by = Object.fromEntries(fold.map((a) => [a.key, a]));
    // Verification runs spend on finding prospects, they do not count as prospects.
    expect(by.prospects_found.actions).toBe(81);
    expect(by.prospects_found.spendUsd).toBeCloseTo(2.77, 10);
    expect(by.follow_ups.actions).toBe(70);
    expect(by.follow_ups.costPerActionUsd).toBeCloseTo(3.98 / 70, 10);
    // Writing has no unit a customer reads: spend only.
    expect(by.messages_written.actions).toBeNull();
    expect(by.messages_written.costPerActionUsd).toBeNull();

    const days = buildSpendChartDays({
      spendByDay: new Map([["2026-10-19", 9.75]]),
      taskRows: rows,
      persons: [],
      durationDays: 0,
      outcomesRequired: 10,
      today: "2026-10-19",
    });
    expect(days[0].byActionGapUsd).toBe(0);
  });
});
