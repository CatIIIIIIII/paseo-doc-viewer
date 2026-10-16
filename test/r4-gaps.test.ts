import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { readBlocks, readRows, renderPage } from "../server/documents";
import { resolveInside, workspaceRoot } from "../server/paths";
import { IMAGE_BUDGET_BYTES } from "../server/raster";
import { errorCode } from "../shared/errors";
import { MAX_RESPONSE_BYTES, XLSX_MAX_ROWS } from "../shared/limits";
import { blankGrayPng, deckPptx, noisePng, textPdf } from "./fixtures/generators.ts";
import { responseBytes, workspace } from "./helpers";
import { docxEntries, pptxEntries, rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

const siblings: string[] = [];
afterEach(() => {
  for (const dir of siblings.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function code(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return errorCode(error);
  }
  return "resolved";
}

describe("R4: cache keys include the requested width", () => {
  it("renders the same PDF page at two widths", async () => {
    const root = workspace({ "a.pdf": await textPdf(["one"]) });
    const narrow = await renderPage({ root, path: "a.pdf" }, { index: 0, maxWidth: 300 });
    const wide = await renderPage({ root, path: "a.pdf" }, { index: 0, maxWidth: 600 });
    if (narrow.kind !== "pdf" || wide.kind !== "pdf") throw new Error("expected pdf");
    expect([narrow.image.width, wide.image.width]).toEqual([300, 600]);
  });

  it("renders the same image at two widths", async () => {
    const root = workspace({ "a.png": blankGrayPng(2000, 1000) });
    const narrow = await renderPage({ root, path: "a.png" }, { index: 0, maxWidth: 300 });
    const wide = await renderPage({ root, path: "a.png" }, { index: 0, maxWidth: 600 });
    if (narrow.kind !== "image-raster" || wide.kind !== "image-raster") throw new Error("expected image");
    expect([narrow.image.width, wide.image.width]).toEqual([300, 600]);
  });
});

describe("R4: workspace containment and lookup", () => {
  it("rejects a sibling directory that shares the root as a prefix", async () => {
    const root = workspace();
    const sibling = `${root}-x`;
    siblings.push(sibling);
    mkdirSync(sibling);
    writeFileSync(join(sibling, "secret.pdf"), "%PDF-1.4");
    expect(await code(() => resolveInside(root, `../${basename(root)}-x/secret.pdf`))).toBe("outside_workspace");
    expect(await code(() => resolveInside(root, join(sibling, "secret.pdf")))).toBe("outside_workspace");
  });

  it("returns the requested workspace across pages", async () => {
    const first = workspace();
    const second = workspace();
    const pages: Record<string, { entries: { id: string; workspaceDirectory: string }[]; pageInfo: { hasMore: boolean; nextCursor?: string } }> = {
      start: { entries: [{ id: "ws-a", workspaceDirectory: first }], pageInfo: { hasMore: true, nextCursor: "p2" } },
      p2: { entries: [{ id: "ws-b", workspaceDirectory: second }], pageInfo: { hasMore: false } },
    };
    const paseo = { workspaces: { list: async ({ page }: { page: { cursor?: string } }) => pages[page.cursor ?? "start"] } };
    expect(await workspaceRoot(paseo as never, "ws-b")).toBe(await import("node:fs/promises").then((fs) => fs.realpath(second)));
    expect(await workspaceRoot(paseo as never, "ws-a")).toBe(await import("node:fs/promises").then((fs) => fs.realpath(first)));
  });
});

describe("R4: response budgets", () => {
  it("re-encodes a noisy PDF page until it fits maxBytes", async () => {
    const document = await PDFDocument.create();
    const image = await document.embedPng(noisePng(1600, 1600));
    document.addPage([800, 800]).drawImage(image, { x: 0, y: 0, width: 800, height: 800 });
    const root = workspace({ "noise.pdf": await document.save() });
    const page = await renderPage({ root, path: "noise.pdf" }, { index: 0, maxWidth: 3000 });
    if (page.kind !== "pdf") throw new Error("expected pdf");
    expect(Buffer.from(page.image.data, "base64").length).toBeLessThanOrEqual(IMAGE_BUDGET_BYTES);
    expect(page.image.width).toBeLessThan(3000);
    expect(responseBytes(page)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  }, 60_000);

  it("stops an xlsx window at the byte budget with 2000-character cells", async () => {
    const rows = Array.from({ length: XLSX_MAX_ROWS }, (_, r) => `<row r="${r + 1}">${`<c t="s"><v>0</v></c>`.repeat(50)}</row>`).join("");
    const strings = { name: "xl/sharedStrings.xml", data: `<sst><si><t>${"x".repeat(2000)}</t></si></sst>` };
    const root = workspace({ "wide.xlsx": rawZip(xlsxEntries([{ name: "W", xml: worksheetXml(rows) }], [strings])) });
    const window = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.rows[0]).toHaveLength(50);
    expect(window.rows.length).toBeLessThan(XLSX_MAX_ROWS);
    expect(window.nextRowOffset).toBe(window.rows.length);
    expect(responseBytes(window)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  }, 30_000);

  it("bounds a docx with a single huge paragraph", async () => {
    const body = `<w:p><w:r><w:t>${"a".repeat(9 * 1024 * 1024)}</w:t></w:r></w:p>`;
    const root = workspace({ "huge.docx": rawZip(docxEntries(body)) });
    const page = await readBlocks({ root, path: "huge.docx" }, { cursor: 0 });
    expect(page.blocks).toHaveLength(1);
    const block = page.blocks[0];
    if (block.type !== "paragraph") throw new Error("expected paragraph");
    expect(block.text.length).toBeGreaterThan(0);
    expect(responseBytes(page)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  }, 30_000);

  it("bounds a pptx slide carrying 10 MB of text", async () => {
    const root = workspace({ "text.pptx": rawZip(pptxEntries([`<a:p><a:r><a:t>${"b".repeat(10 * 1024 * 1024)}</a:t></a:r></a:p>`])) });
    const slide = await renderPage({ root, path: "text.pptx" }, { index: 0 });
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(slide.texts).toHaveLength(1);
    expect(slide.texts[0].length).toBeGreaterThan(0);
    expect(slide.texts[0].length).toBeLessThan(1024 * 1024);
    expect(responseBytes(slide)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  }, 30_000);
});

describe("R4: out-of-range indexes", () => {
  it("rejects a slide past the end of the deck", async () => {
    const root = workspace({ "deck.pptx": await deckPptx([{ title: "a", body: "b" }, { title: "c", body: "d" }]) });
    expect(await code(() => renderPage({ root, path: "deck.pptx" }, { index: 2 }))).toBe("out_of_range");
  });

  it("rejects a second page of an image", async () => {
    const root = workspace({ "a.png": blankGrayPng(10, 10) });
    expect(await code(() => renderPage({ root, path: "a.png" }, { index: 1 }))).toBe("out_of_range");
  });

  it("rejects a sheet past the end of the workbook", async () => {
    const root = workspace({ "a.xlsx": rawZip(xlsxEntries([{ name: "S", xml: worksheetXml("") }])) });
    expect(await code(() => readRows({ root, path: "a.xlsx" }, { sheet: 1, rowOffset: 0, columnOffset: 0 }))).toBe("out_of_range");
  });
});
