import { describe, expect, it } from "vitest";
import { outcomeCatalogueFigures, unroundedStepValue } from "./published-unit-value.js";
import type { CatalogueModel, CataloguePipe, CatalogueStep } from "./agent-catalogue.js";

const step = (key: string, valueUsd: number | null, valueVia: { toStep: string; ratePct: number } | null = null) => ({ key, valueUsd, valueVia }) as unknown as CatalogueStep;
const pipe = (id: string, over: Partial<CataloguePipe>) =>
  ({ id, published: true, outcome: "x_post_published", fromStep: null, toStep: "post_published", operatedBy: "platform", expectedCost: null, computedLegKey: "start_to_post_published", ...over }) as unknown as CataloguePipe;
const model = (pipes: CataloguePipe[], steps: CatalogueStep[], lifetimeRevenueUsd: number | null = 1000) =>
  ({ pipes: new Map(pipes.map((p) => [p.id, p])), steps: new Map(steps.map((s) => [s.key, s])), lifetimeRevenueUsd }) as unknown as Pick<CatalogueModel, "pipes" | "steps" | "lifetimeRevenueUsd">;

// Route: X post published -> Website visit (10%, nobody of ours performs the click: $0) -> Paid client (2%, a platform
// pipe at $5 per paying client). Net value (framework §10): V(visit) = 0.02 x (1000 - 5) = 19.90; V(post) = 0.10 x
// (19.90 - 0) = 1.99. The gross LTR x rates read 0.10 x 0.02 x 1000 = 2.00 (OUTCOME-ACCOUNTING-1107 re-bases it).
const routeSteps = [step("post_published", 2, { toStep: "website_visit", ratePct: 10 }), step("website_visit", 20, { toStep: "paid_client", ratePct: 2 }), step("paid_client", 1000)];
const visitToPaid = pipe("visit|paid", { outcome: "paid_client", fromStep: "website_visit", toStep: "paid_client", expectedCost: { costPerOutcomeUsd: 5, source: "default", basis: "default" } });

describe("published unit value (OUTCOME-ACCOUNTING-1107): NET value on the catalogue route, expected cost of one more Unit", () => {
  it("values the outcome NET along its route; cost = strongest basis, then cheapest", () => {
    const m = model(
      [
        pipe("x|a", { expectedCost: { costPerOutcomeUsd: 0.2, source: "default", basis: "default" } }),
        pipe("x|b", { expectedCost: { costPerOutcomeUsd: 0.9, source: "workflow", basis: "measured" } }),
        pipe("team", { operatedBy: "customer" }),
        pipe("other", { outcome: "threads_post_published", expectedCost: { costPerOutcomeUsd: 0.01, source: "workflow", basis: "measured" } }),
        visitToPaid,
      ],
      routeSteps,
    );
    const f = outcomeCatalogueFigures(m, "x_post_published");
    expect(f).toMatchObject({ step: "post_published", cost: { costPerUnitUsd: 0.9, costSource: "workflow", basis: "measured", pipeId: "x|b" }, unavailableReason: null });
    expect(f.valuePerUnitUsd).toBeCloseTo(1.99, 8);
    expect(f.figures.route).toEqual(["post_published"]);
    expect(f.figures.costFromStartUsd).toBe(0.9);
    expect(f.figures.next).toMatchObject({ step: "website_visit", ratePct: 10, costPerUnitUsd: 0 });
  });

  it("an outcome that is a step itself is valued on it; nothing in the catalogue = a named null", () => {
    const steps = [step("newsletter_email_sent", 0.03, { toStep: "paid_client", ratePct: 0.003 }), step("paid_client", 1000)];
    expect(outcomeCatalogueFigures(model([], steps), "newsletter_email_sent")).toMatchObject({ step: "newsletter_email_sent", cost: null });
    expect(outcomeCatalogueFigures(model([], steps), "newsletter_email_sent").valuePerUnitUsd).toBeCloseTo(0.03, 8);
    expect(outcomeCatalogueFigures(model([], []), "linkedin_post_published")).toMatchObject({ step: null, valuePerUnitUsd: null, unavailableReason: "no_catalogue_step_for_outcome" });
    expect(outcomeCatalogueFigures(model([pipe("x", {})], [step("post_published", null)]), "x_post_published")).toMatchObject({ valuePerUnitUsd: null, unavailableReason: "route_does_not_reach_paid_client" });
  });

  it("a later milestone that costs more than it is worth leaves the Unit worth 0, never negative", () => {
    const dear = pipe("visit|paid", { ...visitToPaid, expectedCost: { costPerOutcomeUsd: 5000, source: "default", basis: "default" } });
    expect(outcomeCatalogueFigures(model([pipe("x|b", {}), dear], routeSteps), "x_post_published").valuePerUnitUsd).toBe(0);
  });

  it("a step worth a fraction of a cent keeps its value (never the catalogue's $0.00 rounding)", () => {
    const steps = [step("newsletter_email_sent", 0, { toStep: "website_visit", ratePct: 0.01 }), step("website_visit", 0.5, { toStep: "paid_client", ratePct: 0.02 }), step("paid_client", 2500)];
    const m = model([], steps, 2500);
    expect(unroundedStepValue(m, "newsletter_email_sent")).toBeCloseTo(0.0001 * 0.0002 * 2500, 10);
    expect(outcomeCatalogueFigures(m, "newsletter_email_sent").valuePerUnitUsd).toBeCloseTo(0.0001 * 0.0002 * 2500, 10);
  });
});
