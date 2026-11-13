import { describe, expect, it, vi } from "vitest";

vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
const { favouritesOfBoard, writingTactic } = await import("./engine-favourites.js");

/** SCRIPT-VALUE-RATING-1113-MON: what a pipe runs today = the favourite SCRIPT's own LLM / template tactics. */
const row = (scriptDynasty: string, llms: Array<{ place: string | null; provider: string | null; model: string | null }>, templates: Array<{ place: string | null; templateDynastySlug: string }>) =>
  ({ scriptDynasty, llms, templates }) as never;

describe("favouritesOfBoard", () => {
  const dyn = (name: string) => (name === "gemini-3.1-flash-lite" ? { slug: "gemini-flash-lite", name: "Gemini Flash Lite" } : null);

  it("names the favourite script's writer LLM by its dynasty and its template", () => {
    const fav = favouritesOfBoard(
      { outcome: "message_written", favourite: "message_written/a", scripts: [row("message_written/b", [], []), row("message_written/a", [{ place: "angles", provider: "x", model: "other" }, { place: "writer", provider: "google", model: "gemini-3.1-flash-lite" }], [{ place: "writer", templateDynastySlug: "blind-email" }])] },
      dyn,
    );
    expect(fav).toEqual({ outcome: "message_written", script: "message_written/a", llm: { key: "gemini-flash-lite", name: "Gemini Flash Lite" }, template: { key: "blind-email", name: "blind-email" } });
  });

  it("no favourite = nothing named; a model chat-service places nowhere keeps its own name", () => {
    expect(favouritesOfBoard({ outcome: "o", favourite: null, scripts: [] }, dyn)).toEqual({ outcome: "o", script: null, llm: null, template: null });
    expect(favouritesOfBoard({ outcome: "o", favourite: "o/a", scripts: [row("o/a", [{ place: null, provider: null, model: "mystery" }], [])] }, dyn).llm).toEqual({ key: "mystery", name: "mystery" });
  });

  it("writingTactic prefers the whole-script entry, then the writer", () => {
    expect(writingTactic([{ place: "angles" }, { place: "writer" }])).toEqual({ place: "writer" });
    expect(writingTactic([{ place: "angles" }, { place: null }])).toEqual({ place: null });
    expect(writingTactic([])).toBeNull();
  });
});
