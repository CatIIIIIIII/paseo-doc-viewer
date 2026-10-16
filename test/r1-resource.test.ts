import { closeSync, openSync, writeSync, ftruncateSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { PDFiumLibrary } from "@hyzyla/pdfium/inline";
import UTIF from "utif2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKeys, memo } from "../server/cache";
import { openDocument, readBlocks, readRows, renderPage } from "../server/documents";
import { heavy } from "../server/heavy";
import { pdfPageCount } from "../server/pdf";
import { SLIDE_TEXT_TRUNCATED } from "../server/pptx";
import { decodeEntities } from "../server/html";
import { ERROR_MESSAGES, errorCode } from "../shared/errors";
import { MAX_RESPONSE_BYTES, RPC_DEADLINE_MS } from "../shared/limits";
import { blankGrayPng, deckPptx, noisePng, textPdf } from "./fixtures/generators.ts";
import { responseBytes, timed, workspace } from "./helpers";
import { docxEntries, pptxEntries, rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

const MiB = 1024 * 1024;

function sparse(root: string, name: string, head: Uint8Array, size: number): void {
  const fd = openSync(join(root, name), "w");
  writeSync(fd, head);
  ftruncateSync(fd, size);
  closeSync(fd);
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

afterEach(() => vi.restoreAllMocks());

describe("R1a: per-kind file size caps are checked before reading", () => {
  it.each([
    ["huge.pdf", Buffer.from("%PDF-1.7\n"), 600 * MiB],
    ["huge.pptx", Buffer.from([0x50, 0x4b, 0x03, 0x04]), 80 * MiB],
    ["huge.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04]), 80 * MiB],
    ["huge.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04]), 80 * MiB],
    ["huge.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), 200 * MiB],
    ["huge.tiff", Buffer.from("II*\0", "latin1"), 200 * MiB],
  ])("%s is rejected as too large", async (name, head, size) => {
    const root = workspace();
    sparse(root, name, head, size);
    const { value, ms } = await timed(() => failure(() => openDocument({ root, path: name })));
    expect(errorCode(value)).toBe("too_large");
    expect(ms).toBeLessThan(500);
  });
});

describe("R1b: zip-based office files are checked against the central directory before parsing", () => {
  it("rejects a pptx whose media part declares more than the total cap", async () => {
    const zip = rawZip(pptxEntries(["<a:p><a:r><a:t>x</a:t></a:r></a:p>"], [{ name: "ppt/media/bomb.png", data: "tiny", declaredSize: 400 * MiB }]));
    const root = workspace({ "bomb.pptx": zip });
    const { value, ms } = await timed(() => failure(() => openDocument({ root, path: "bomb.pptx" })));
    expect(errorCode(value)).toBe("too_large");
    expect(ms).toBeLessThan(500);
  });

  it("rejects a docx whose document.xml declares more than the per-part cap", async () => {
    const entries = docxEntries("<w:p/>").map((entry) =>
      entry.name === "word/document.xml" ? { ...entry, declaredSize: 40 * MiB } : entry,
    );
    const root = workspace({ "big.docx": rawZip(entries) });
    expect(errorCode(await failure(() => openDocument({ root, path: "big.docx" })))).toBe("too_large");
  });

  it("rejects a docx with more XML elements than the converter can hold", async () => {
    const root = workspace({ "dense.docx": rawZip(docxEntries("<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(50_000))) });
    const { value, ms } = await timed(() => failure(() => openDocument({ root, path: "dense.docx" })));
    expect(errorCode(value)).toBe("too_large");
    expect(ms).toBeLessThan(2_000);
  });

  it("rejects a docx whose document.xml inflates past its declared size", async () => {
    const real = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${"<w:p/>".repeat(8 * MiB)}</w:body></w:document>`;
    const entries = docxEntries("").map((entry) =>
      entry.name === "word/document.xml" ? { ...entry, deflated: deflateRawSync(real), declaredSize: 1024 } : entry,
    );
    const root = workspace({ "lying.docx": rawZip(entries) });
    const { value, ms } = await timed(() => failure(() => openDocument({ root, path: "lying.docx" })));
    expect(["too_large", "damaged"]).toContain(errorCode(value));
    expect(ms).toBeLessThan(5_000);
  });

  it("reads an xlsx whose entry count overflows the 16-bit end-of-directory field", async () => {
    const extra = Array.from({ length: 66_000 }, (_, i) => ({ name: `xl/junk/${i}.bin`, data: "" }));
    const root = workspace({ "wrapped.xlsx": rawZip(xlsxEntries([{ name: "S", xml: worksheetXml("") }], extra)) });
    expect(await openDocument({ root, path: "wrapped.xlsx" })).toMatchObject({ kind: "xlsx", sheets: [{ name: "S" }] });
  }, 20_000);

  it("rejects a pptx with an excessive number of entries", async () => {
    const extra = Array.from({ length: 20_001 }, (_, i) => ({ name: `ppt/junk/${i}.bin`, data: "" }));
    const root = workspace({ "many.pptx": rawZip(pptxEntries([""], extra)) });
    expect(errorCode(await failure(() => openDocument({ root, path: "many.pptx" })))).toBe("too_large");
  });
});

describe("R1c: xlsx streams only the requested window", () => {
  const rows = (count: number, offset = 0) => {
    const parts: string[] = [];
    for (let r = offset + 1; r <= offset + count; r++) {
      parts.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}" t="inlineStr"><is><t>row ${r}</t></is></c></row>`);
    }
    return parts.join("");
  };

  it("opens a 400k-row sheet and reads a deep window quickly", async () => {
    const root = workspace({ "big.xlsx": rawZip(xlsxEntries([{ name: "Data", xml: worksheetXml(rows(400_000), "A1:B400000") }])) });
    const { value: opened, ms: openMs } = await timed(() => openDocument({ root, path: "big.xlsx" }));
    if (opened.kind !== "xlsx") throw new Error("expected xlsx");
    expect(opened.sheets[0]).toMatchObject({ name: "Data", rowCount: 400_000, columnCount: 2 });
    expect(openMs).toBeLessThan(1_000);
    const { value: deep, ms } = await timed(() => readRows({ root, path: "big.xlsx" }, { sheet: 0, rowOffset: 399_900, columnOffset: 0 }));
    expect(deep.rows[0]).toEqual(["399901", "row 399901"]);
    expect(deep.rows).toHaveLength(100);
    expect(deep.nextRowOffset).toBeNull();
    expect(ms).toBeLessThan(8_000);
  }, 30_000);

  it("renders uncached formulas, shared strings, booleans, and styled dates", async () => {
    const xml = worksheetXml(
      `<row r="1"><c r="A1"><f>B1*2</f></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" s="1"><v>46036</v></c><c r="F1"><v>1.5</v></c></row>`,
      "A1:F1",
    );
    const extra = [
      { name: "xl/sharedStrings.xml", data: `<sst><si><t>zero</t></si><si><r><t>o&amp;</t></r><r><t xml:space="preserve">ne</t></r><rPh><t>x</t></rPh></si></sst>` },
      { name: "xl/styles.xml", data: `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>` },
    ];
    const root = workspace({ "kinds.xlsx": rawZip(xlsxEntries([{ name: "K", xml }], extra)) });
    const window = await readRows({ root, path: "kinds.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.rows).toEqual([["=B1*2", "o&ne", "true", "2026-01-14", "", "1.5"]]);
  });

  it("caps the sheet list of a workbook with thousands of sheets and flags it", async () => {
    const sheets = Array.from({ length: 3_000 }, (_, i) => ({ name: `${i}${"表".repeat(30)}`.slice(0, 31), xml: worksheetXml(rows(1)) }));
    const root = workspace({ "sheets.xlsx": rawZip(xlsxEntries(sheets)) });
    const opened = await openDocument({ root, path: "sheets.xlsx" });
    if (opened.kind !== "xlsx") throw new Error("expected xlsx");
    expect(opened.sheetsTruncated).toBe(true);
    expect(opened.sheets.length).toBeLessThan(3_000);
    expect(responseBytes(opened)).toBeLessThan(MAX_RESPONSE_BYTES / 8);
  }, 30_000);
});

describe("R1d: slide and document images share a decode budget", () => {
  it("decodes a media part referenced 200 times once", async () => {
    const deck = await deckPptx([{ title: "Many", body: "same picture", images: [blankGrayPng(6000, 6000)] }]);
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(deck);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    const picture = /<p:pic>[\s\S]*?<\/p:pic>/.exec(xml)![0];
    zip.file("ppt/slides/slide1.xml", xml.replace(picture, picture.repeat(200)));
    const root = workspace({ "many.pptx": await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) });
    const { value: slide, ms } = await timed(() => renderPage({ root, path: "many.pptx" }, { index: 0 }));
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(slide.images).toHaveLength(1);
    expect(ms).toBeLessThan(10_000);
  }, 30_000);

  it("omits images past the per-request pixel budget with a reason", async () => {
    const images = [1, 2, 3, 4, 5, 6].map(() => blankGrayPng(5000, 5000));
    images.forEach((image, i) => image.writeUInt8(i, 33));
    const root = workspace({ "heavy.pptx": await deckPptx([{ title: "Heavy", body: "x", images }]) });
    const slide = await renderPage({ root, path: "heavy.pptx" }, { index: 0 });
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(slide.omittedImages).toBeGreaterThan(0);
    expect(slide.omittedReasons?.length).toBeGreaterThan(0);
  }, 30_000);

  it("bounds slide text under the response budget and marks the cut", async () => {
    const paragraph = (i: number) => `<a:p><a:r><a:t>${String(i).padEnd(20_000, "x")}</a:t></a:r></a:p>`;
    const body = Array.from({ length: 500 }, (_, i) => paragraph(i)).join("");
    const root = workspace({ "wordy.pptx": rawZip(pptxEntries([body])) });
    const slide = await renderPage({ root, path: "wordy.pptx" }, { index: 0 });
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(responseBytes(slide.texts)).toBeLessThan(MAX_RESPONSE_BYTES / 2);
    expect(slide.texts.length).toBeLessThan(500);
    expect(slide.texts.at(-1)).toBe(SLIDE_TEXT_TRUNCATED);
  }, 30_000);

  it("gives each image on a slide a fair share of the response budget", async () => {
    const images = [noisePng(2000, 2000, 1), noisePng(2000, 2000, 2)];
    const root = workspace({ "pair.pptx": await deckPptx([{ title: "Pair", body: "x", images }]) });
    const slide = await renderPage({ root, path: "pair.pptx" }, { index: 0 });
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(slide.omittedImages).toBe(0);
    const [first, second] = slide.images.map((image) => image.data.length);
    expect(first).toBeLessThan(MAX_RESPONSE_BYTES / 2);
    expect(second).toBeGreaterThan(first! / 2);
    expect(responseBytes(slide)).toBeLessThan(MAX_RESPONSE_BYTES);
  }, 60_000);

  it("rejects a TIFF whose strips cannot hold its declared dimensions", async () => {
    const small = Buffer.from(UTIF.encodeImage(new Uint8Array(2 * 2 * 4).fill(200), 2, 2));
    const le = small.readUInt16LE(0) === 0x4949;
    const u16 = (at: number) => (le ? small.readUInt16LE(at) : small.readUInt16BE(at));
    const ifd = le ? small.readUInt32LE(4) : small.readUInt32BE(4);
    for (let i = 0; i < u16(ifd); i++) {
      const entry = ifd + 2 + i * 12;
      const tag = u16(entry);
      if (tag !== 256 && tag !== 257) continue;
      if (u16(entry + 2) === 3) le ? small.writeUInt16LE(6000, entry + 8) : small.writeUInt16BE(6000, entry + 8);
      else le ? small.writeUInt32LE(6000, entry + 8) : small.writeUInt32BE(6000, entry + 8);
    }
    const root = workspace({ "x.tiff": small });
    const { value, ms } = await timed(() => failure(() => renderPage({ root, path: "x.tiff" }, { index: 0 })));
    expect(errorCode(value)).toBe("damaged");
    expect(ms).toBeLessThan(2_000);
  });
});

describe("R1e: heavy work is serialized", () => {
  it("runs at most two heavy tasks at once", async () => {
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        heavy(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("times out a job that never settles and frees its slot for later jobs", async () => {
    vi.useFakeTimers();
    try {
      const hung = [0, 1].map(() => failure(() => heavy(() => new Promise(() => {}))));
      await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS / 2);
      const later = heavy(async () => "done");
      await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS / 2);
      for (const error of await Promise.all(hung)) expect(errorCode(error)).toBe("timeout");
      expect(await later).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("R1f: a PDF is loaded once per revision", () => {
  it("renders three pages from a single PDFium load", async () => {
    const load = vi.spyOn(PDFiumLibrary.prototype, "loadDocument");
    const root = workspace({ "three.pdf": await textPdf(["one", "two", "three"]) });
    await openDocument({ root, path: "three.pdf" });
    for (const index of [0, 1, 2]) await renderPage({ root, path: "three.pdf" }, { index, maxWidth: 300 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("opens a PDF larger than the held budget but never holds it alongside another", async () => {
    const load = vi.spyOn(PDFiumLibrary.prototype, "loadDocument");
    const root = workspace({ "small.pdf": await textPdf(["small"]), "big.pdf": await textPdf(["big"]) });
    const small = { path: join(root, "small.pdf"), revision: "1", size: MiB };
    const big = { path: join(root, "big.pdf"), revision: "1", size: 300 * MiB };
    expect(await pdfPageCount(small)).toBe(1);
    expect(await pdfPageCount(big)).toBe(1);
    expect(await pdfPageCount(small)).toBe(1);
    expect(await pdfPageCount(big)).toBe(1);
    expect(load).toHaveBeenCalledTimes(4);
  });
});

describe("R1g: the result cache", () => {
  it("skips an oversize entry instead of evicting everything", async () => {
    const small = vi.fn(async () => "small");
    await memo({ path: "/a", revision: "1", name: "x" }, small, () => 10);
    await memo({ path: "/b", revision: "1", name: "x" }, async () => "huge", () => 10 * 1024 * MiB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await memo({ path: "/a", revision: "1", name: "x" }, small, () => 10);
    expect(small).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed computation, so a timeout is retried on the same revision", async () => {
    const key = { path: "/fail", revision: "1", name: "x" };
    await expect(memo(key, async () => Promise.reject(new Error(ERROR_MESSAGES.busy())))).rejects.toThrow(/busy/);
    expect(cacheKeys().filter((id) => id.startsWith("/fail\0"))).toEqual([]);
    expect(await memo(key, async () => "ok")).toBe("ok");
  });

  it("drops older revisions of the same path on insert", async () => {
    await memo({ path: "/rev", revision: "1", name: "x" }, async () => 1, () => 1);
    await memo({ path: "/rev", revision: "2", name: "x" }, async () => 2, () => 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const keys = cacheKeys().filter((key) => key.startsWith("/rev\0"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("\u00002\u0000");
  });
});

describe("R1h: markup robustness", () => {
  it("maps invalid numeric entities to U+FFFD", () => {
    expect(decodeEntities("a&#1114112;b&#0;c&#xD800;d&#65;")).toBe("a�b�c�dA");
  });

  it("renders a slide containing an out-of-range entity", async () => {
    const root = workspace({ "deck.pptx": await deckPptx([{ title: "Hello &#1114112; world", body: "fine" }, { title: "ok", body: "ok" }]) });
    const slide = await renderPage({ root, path: "deck.pptx" }, { index: 0 });
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(slide.texts[0]).toBe("Hello � world");
  });

  it("a broken slide does not break the rest of the deck", async () => {
    const zip = rawZip(pptxEntries(["<a:p><a:r><a:t>fine</a:t></a:r></a:p>", "<a:p><a:r><a:t>also fine</a:t></a:r></a:p>"]));
    const broken = Buffer.from(zip);
    const marker = broken.indexOf(Buffer.from("ppt/slides/slide1.xml"));
    broken[marker + "ppt/slides/slide1.xml".length + 2] ^= 0xff;
    const root = workspace({ "deck.pptx": broken });
    const opened = await openDocument({ root, path: "deck.pptx" });
    expect(opened).toMatchObject({ kind: "pptx", slideCount: 2 });
    const second = await renderPage({ root, path: "deck.pptx" }, { index: 1 });
    if (second.kind !== "pptx") throw new Error("expected pptx");
    expect(second.texts).toEqual(["also fine"]);
  });
});

describe("R1: bounded docx and blocks still page", () => {
  it("a docx with one figure still reads", async () => {
    const root = workspace({ "a.docx": rawZip(docxEntries("<w:p><w:r><w:t>hello</w:t></w:r></w:p>")) });
    const page = await readBlocks({ root, path: "a.docx" }, { cursor: 0 });
    expect(page.blocks).toEqual([{ type: "paragraph", text: "hello" }]);
  });
});
