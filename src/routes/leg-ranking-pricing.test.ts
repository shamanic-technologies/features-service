import { describe, expect, it, vi } from "vitest";
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
import { legDefaultConversionPct, legRankingOnPricing, type LegWorkflowRankingPayload } from "./public.js";
import type { LegWorkflowRankingRow } from "../lib/leg-workflow-ranking.js";

// RESEARCH-WF-FIGURES-1022: `?pricing=net` serves each row's net figures as `figures`, never both.
describe("leg workflow ranking on a pricing", () => {
  const figures = (pricing: "gross" | "net") => ({ pricing }) as unknown as NonNullable<LegWorkflowRankingRow["figures"]>;
  const payload = { featureSlug: "f", legKey: "start_to_conversation", rows: [{ workflowDynastySlug: "a", figures: figures("gross"), figuresNet: figures("net") }] } as unknown as LegWorkflowRankingPayload;

  it("net serves the net figures under `figures`, gross the gross ones, and the twin is never served", () => {
    const net = legRankingOnPricing(payload, "net");
    expect(net.pricing).toBe("net");
    expect(net.rows[0].figures!.pricing).toBe("net");
    expect("figuresNet" in net.rows[0]).toBe(false);
    const gross = legRankingOnPricing(payload, "gross");
    expect(gross.rows[0].figures!.pricing).toBe("gross");
    expect("figuresNet" in gross.rows[0]).toBe(false);
  });

  it("serves the live tactics of each row, or says they could not be read", () => {
    const withTactics = legRankingOnPricing(payload, "gross", (d) => (d === "a" ? [{ id: "blind-angle", name: "Blind angle" }] : []));
    expect(withTactics.rows[0]).toMatchObject({ tactics: [{ id: "blind-angle", name: "Blind angle" }], tacticsUnavailableReason: null });
    const unreadable = legRankingOnPricing(payload, "gross", null);
    expect(unreadable.rows[0]).toMatchObject({ tactics: null, tacticsUnavailableReason: "tactics_unreadable" });
  });

  it("states the leg's seeded conversion for an entry leg", () => {
    expect(legDefaultConversionPct("start_to_conversation")).toBe(1);
    expect(legDefaultConversionPct("start_to_website_visit")).toBe(2);
  });
});
