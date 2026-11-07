import { describe, expect, it } from "vitest";
import { outcomeCatalogueFigures } from "./published-unit-value.js";
import type { CatalogueModel, CataloguePipe, CatalogueStep } from "./agent-catalogue.js";

const step = (key: string, valueUsd: number | null) => ({ key, valueUsd }) as unknown as CatalogueStep;
const pipe = (id: string, over: Partial<CataloguePipe>) =>
  ({ id, published: true, outcome: "x_post_published", toStep: "post_published", operatedBy: "platform", expectedCost: null, ...over }) as unknown as CataloguePipe;
const model = (pipes: CataloguePipe[], steps: CatalogueStep[]) =>
  ({ pipes: new Map(pipes.map((p) => [p.id, p])), steps: new Map(steps.map((s) => [s.key, s])) }) as unknown as Pick<CatalogueModel, "pipes" | "steps">;

describe("published unit value (SOCIAL-OUTCOMES-1107): the outcome's step value and the expected cost of one more Unit", () => {
  it("values a finer outcome on the step its Engine's pipe lands on; cost = strongest basis, then cheapest", () => {
    const m = model(
      [
        pipe("x|a", { expectedCost: { costPerOutcomeUsd: 0.2, source: "default", basis: "default" } }),
        pipe("x|b", { expectedCost: { costPerOutcomeUsd: 0.9, source: "workflow", basis: "measured" } }),
        pipe("team", { operatedBy: "customer" }),
        pipe("other", { outcome: "threads_post_published", expectedCost: { costPerOutcomeUsd: 0.01, source: "workflow", basis: "measured" } }),
      ],
      [step("post_published", 1.5)],
    );
    expect(outcomeCatalogueFigures(m, "x_post_published")).toEqual({ step: "post_published", valuePerUnitUsd: 1.5, cost: { costPerUnitUsd: 0.9, costSource: "workflow", basis: "measured", pipeId: "x|b" }, unavailableReason: null });
  });

  it("an outcome that is a step itself is valued on it; nothing in the catalogue = a named null", () => {
    expect(outcomeCatalogueFigures(model([], [step("newsletter_email_sent", 0.03)]), "newsletter_email_sent")).toMatchObject({ step: "newsletter_email_sent", valuePerUnitUsd: 0.03, cost: null });
    expect(outcomeCatalogueFigures(model([], []), "linkedin_post_published")).toMatchObject({ step: null, valuePerUnitUsd: null, unavailableReason: "no_catalogue_step_for_outcome" });
    expect(outcomeCatalogueFigures(model([pipe("x", {})], [step("post_published", null)]), "x_post_published")).toMatchObject({ valuePerUnitUsd: null, unavailableReason: "step_has_no_value" });
  });
});
