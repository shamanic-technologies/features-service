import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetLiveTemplateDynastiesForTest, readLiveTemplateDynasties } from "./writer-catalogue-client.js";

const body = (status: string) => JSON.stringify({ dynasties: [{ slug: "d", name: "D", status, head: "v1", versions: [{ type: "v1", position: 1, statusInDynasty: status }] }] });

// TPL-STATUS-LIVE-1023: a re-read slower than the wait cap (or unreadable) serves the last good answer, never blocks the page.
describe("readLiveTemplateDynasties", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetLiveTemplateDynastiesForTest();
  });

  it("serves the fresh answer, then the last good one while a slow or failed re-read runs, then the re-read's", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "http://cg";
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(body("active")));
    const first = await readLiveTemplateDynasties("c", "l");
    expect(typeof first !== "string" && first[0]!.status).toBe("active");

    now += 4_000; // past the 3 s hold: a slow re-read
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    const slow = await readLiveTemplateDynasties("c", "l");
    expect(typeof slow !== "string" && slow[0]!.status).toBe("active");
    release(new Response(body("deprecated")));
    await new Promise((r) => setTimeout(r, 10));
    const landed = await readLiveTemplateDynasties("c", "l");
    expect(typeof landed !== "string" && landed[0]!.status).toBe("deprecated");

    now += 4_000; // an unreadable re-read keeps the last good answer
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await readLiveTemplateDynasties("c", "l");
    expect(typeof failed !== "string" && failed[0]!.status).toBe("deprecated");
  });

  it("with no good answer yet, an unreadable read says so", async () => {
    process.env.CONTENT_GENERATION_SERVICE_URL = "http://cg";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readLiveTemplateDynasties("x", "y")).toBe("template_dynasties_unreadable");
  });
});
