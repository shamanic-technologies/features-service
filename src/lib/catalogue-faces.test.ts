import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));

import { faceOf, faceSvg, faceTraitsOf, FACE_ANIMALS } from "./catalogue-faces.js";
import { FAMILY_WORDS } from "./sales-path-names.js";

describe("the face of a sales funnel name", () => {
  it("is a pure function of the name (same name, same face)", () => {
    expect(faceTraitsOf("Victory")).toEqual(faceTraitsOf("Victory"));
    expect(faceSvg("Victory")).toBe(faceSvg("victory ".trim().replace(/^v/, "V")));
    expect(faceOf("Bold Victory").svgPath).toBe("/public/catalogue/faces/Bold%20Victory.svg");
  });

  it("is a well-formed SVG naming itself", () => {
    const svg = faceSvg("Jubilation");
    expect(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\"")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("<title>Jubilation</title>");
  });

  it("spreads the funnel words over every animal", () => {
    const animals = new Set(FAMILY_WORDS.sales_funnel.map((w) => faceTraitsOf(w).animal));
    expect(animals.size).toBe(FACE_ANIMALS.length);
    const faces = new Set(FAMILY_WORDS.sales_funnel.slice(0, 200).map((w) => JSON.stringify(faceTraitsOf(w))));
    expect(faces.size).toBeGreaterThan(150);
  });
});
