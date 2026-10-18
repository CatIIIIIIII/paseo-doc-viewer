import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFIUM_IDLE_MS, pdfPageCount, readPdfPageText } from "../server/pdf";
import { pdfium, pdfiumStats } from "../server/pdfium";
import { textPdf } from "./fixtures/generators.ts";
import { nestedFormPdf } from "./fixtures/hostile";
import { workspace } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function pdf(name: string, pages: string[]) {
  const root = workspace({ [name]: await textPdf(pages) });
  return { path: join(root, name), revision: "1", size: 1024, passwordKey: "" };
}

describe("R11: PDFium is released after a minute without PDF work", () => {
  it("stops the PDFium worker once idle, then starts a new one on the next request", async () => {
    const file = await pdf("idle.pdf", ["one", "two"]);

    expect(await pdfPageCount(file)).toBe(2);
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS - 1);
    expect(await readPdfPageText(file, 1)).toMatchObject({ text: "two" });
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS - 1);
    expect(pdfiumStats().alive).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(pdfiumStats().alive).toBe(false);

    const spawns = pdfiumStats().spawns;
    expect(await readPdfPageText(file, 0)).toMatchObject({ text: "one" });
    expect(pdfiumStats().spawns).toBe(spawns + 1);
  });

  it("does not recycle while a request is still running", async () => {
    await pdfPageCount(await pdf("busy.pdf", ["busy"]));
    // A nested-form page takes about a second of real time to render.
    await pdfium({ op: "open", key: "r11-slow", bytes: nestedFormPdf(9) });
    const spawns = pdfiumStats().spawns;
    const pending = pdfium({ op: "render", key: "r11-slow", index: 0, width: 800, height: 800 }, { timeoutMs: PDFIUM_IDLE_MS * 10 });
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS * 2);
    expect(pdfiumStats()).toMatchObject({ alive: true, spawns });
    expect((await pending).data.length).toBe(800 * 800 * 4);
    await pdfium({ op: "close", key: "r11-slow" });
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS);
    expect(pdfiumStats().alive).toBe(false);
  }, 30_000);
});
