import { join } from "node:path";
import { PDFiumDocument, PDFiumLibrary } from "@hyzyla/pdfium/inline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFIUM_IDLE_MS, pdfPageCount, readPdfPageText } from "../server/pdf";
import { textPdf } from "./fixtures/generators.ts";
import { workspace } from "./helpers";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function pdf(name: string, pages: string[]) {
  const root = workspace({ [name]: await textPdf(pages) });
  return { path: join(root, name), revision: "1", size: 1024 };
}

describe("R11: PDFium is released after a minute without PDF work", () => {
  it("destroys held documents and the library once idle, then reloads on the next request", async () => {
    const init = vi.spyOn(PDFiumLibrary, "init");
    const destroyLibrary = vi.spyOn(PDFiumLibrary.prototype, "destroy");
    const destroyDocument = vi.spyOn(PDFiumDocument.prototype, "destroy");
    const file = await pdf("idle.pdf", ["one", "two"]);

    expect(await pdfPageCount(file)).toBe(2);
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS - 1);
    expect(await readPdfPageText(file, 1)).toMatchObject({ text: "two" });
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS - 1);
    expect(destroyDocument).not.toHaveBeenCalled();
    expect(destroyLibrary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(destroyDocument).toHaveBeenCalledTimes(1);
    expect(destroyLibrary).toHaveBeenCalledTimes(1);
    expect(destroyDocument.mock.invocationCallOrder[0]).toBeLessThan(destroyLibrary.mock.invocationCallOrder[0]!);

    const initsBefore = init.mock.calls.length;
    expect(await readPdfPageText(file, 0)).toMatchObject({ text: "one" });
    expect(init).toHaveBeenCalledTimes(initsBefore + 1);
  });

  it("does not recycle while a request is still running", async () => {
    const destroyLibrary = vi.spyOn(PDFiumLibrary.prototype, "destroy");
    const file = await pdf("busy.pdf", ["busy"]);
    await pdfPageCount(file);

    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = PDFiumLibrary.prototype.loadDocument;
    vi.spyOn(PDFiumLibrary.prototype, "loadDocument").mockImplementationOnce(async function (this: PDFiumLibrary, ...args) {
      await blocked;
      return original.apply(this, args);
    });
    const slow = await pdf("slow.pdf", ["slow"]);
    const pending = pdfPageCount(slow);
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS * 2);
    expect(destroyLibrary).not.toHaveBeenCalled();
    finish();
    expect(await pending).toBe(1);
    await vi.advanceTimersByTimeAsync(PDFIUM_IDLE_MS);
    expect(destroyLibrary).toHaveBeenCalledTimes(1);
  });
});
