import { PDFiumLibrary } from "@hyzyla/pdfium/inline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPageText, renderPage } from "../server/documents";
import { errorCode } from "../shared/errors";
import { MAX_RESPONSE_BYTES, PDF_MAX_TEXT_CHARS } from "../shared/limits";
import { docTextRpc } from "../shared/rpc";
import { textPdf } from "./fixtures/generators.ts";
import { responseBytes, workspace, workspaceWithFixtures } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

afterEach(() => vi.restoreAllMocks());

describe("R10: a PDF page's text can be read and copied", () => {
  it("returns each page's text with line breaks as \\n", async () => {
    const root = workspace({ "notes.pdf": await textPdf(["Invoice 1001 total 24,000", "Line A\nLine B"]) });
    const first = await readPageText({ root, path: "notes.pdf" }, { index: 0 });
    expect(docTextRpc.output.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ kind: "pdf", index: 0, pageCount: 2, text: "Invoice 1001 total 24,000", truncated: false });
    const second = await readPageText({ root, path: "notes.pdf" }, { index: 1 });
    expect(second.text).toBe("Line A\nLine B");
  });

  it("returns empty text for a page without a text layer", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    const page = await readPageText({ root, path: "statement.pdf" }, { index: 0 });
    expect(page).toMatchObject({ pageCount: 3, text: "", truncated: false });
  });

  it("shares the loaded document with page renders", async () => {
    const load = vi.spyOn(PDFiumLibrary.prototype, "loadDocument");
    const root = workspace({ "shared.pdf": await textPdf(["one", "two"]) });
    await renderPage({ root, path: "shared.pdf" }, { index: 0, maxWidth: 200 });
    await readPageText({ root, path: "shared.pdf" }, { index: 1 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("caps very long page text under the response budget and flags the cut", async () => {
    const line = "x".repeat(199);
    const root = workspace({ "long.pdf": await textPdf([Array.from({ length: 800 }, () => line).join("\n")]) });
    const page = await readPageText({ root, path: "long.pdf" }, { index: 0 });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(PDF_MAX_TEXT_CHARS);
    expect(responseBytes(page)).toBeLessThan(MAX_RESPONSE_BYTES);
  }, 30_000);

  it("rejects a page past the end and documents that are not PDFs", async () => {
    const root = workspace({
      "one.pdf": await textPdf(["only"]),
      "sheet.xlsx": rawZip(xlsxEntries([{ name: "S", xml: worksheetXml("") }])),
    });
    await expect(readPageText({ root, path: "one.pdf" }, { index: 1 })).rejects.toThrow(/out of range/);
    const error = await readPageText({ root, path: "sheet.xlsx" }, { index: 0 }).catch((caught: unknown) => caught);
    expect(errorCode(error)).toBe("invalid_request");
  });
});
