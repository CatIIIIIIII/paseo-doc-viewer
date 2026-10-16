import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import mammoth from "mammoth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertDocx, docxBlocks, docxImage, streamDocx, type DocxModel, type SourceBlock } from "../server/docx";
import { openDocument, readBlocks } from "../server/documents";
import { readZipIndex } from "../server/zip";
import { blankGrayPng } from "./fixtures/generators.ts";
import { FIXTURES, PLUGIN_ROOT, workspace } from "./helpers";
import { docxEntries, rawZip } from "./zip-builder";

const run = promisify(execFile);
const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const NAMESPACES =
  `${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ` +
  `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ` +
  `xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ` +
  `xmlns:v="urn:schemas-microsoft-com:vml"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const run_ = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (body: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${body}</w:p>`;
const styled = (style: string, text: string) => para(run_(text), `<w:pStyle w:val="${style}"/>`);
const item = (numId: number, level: number, text: string) =>
  para(run_(text), `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);
const drawing = (rel: string, alt: string) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="Picture" descr="${alt}"/>` +
  `<a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rel}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>` +
  `</wp:inline></w:drawing></w:r>`;
const cell = (body: string, props = "") => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ""}${body}</w:tc>`;

function richDocx(): Buffer {
  const body = [
    styled("Heading1", "Title &amp; more"),
    styled("Berschrift2", "Section two"),
    styled("Heading", "Pages heading"),
    para(
      `${run_("a")}<w:r><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r>` +
        `<w:hyperlink r:id="rIdLink"><w:r><w:t> link</w:t></w:r></w:hyperlink>` +
        `<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t> added</w:t></w:r></w:ins>` +
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run_(" 7")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      `<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:rPr><w:b/></w:rPr>`,
    ),
    para(""),
    para(run_("   ")),
    item(1, 0, "first bullet"),
    item(1, 1, "nested number"),
    item(1, 0, "second bullet"),
    item(2, 0, "one"),
    item(2, 0, "two"),
    item(9, 0, "unknown numbering"),
    para(`${run_("Figure:")}${drawing("rIdImg", "A chart")}`),
    para(drawing("rIdImg", "")),
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>` +
      `<w:tr>${cell(para(run_("A1")) + para("") + para(run_("A1b")), `<w:vMerge w:val="restart"/>`)}${cell(para(run_("B1")))}</w:tr>` +
      `<w:tr>${cell(para(""), "<w:vMerge/>")}${cell(para(run_("B2")) + `<w:tbl><w:tr>${cell(para(run_("inner")))}</w:tr></w:tbl>`)}</w:tr>` +
      `<w:tr>${cell(para(run_("x") + drawing("rIdImg", "in table")))}${cell("")}</w:tr>` +
      `</w:tbl>`,
    para(run_("merged "), `<w:rPr><w:del w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"/></w:rPr>`),
    para(run_("into the next paragraph")),
    `<w:tbl><w:tr><w:trPr><w:del w:id="2" w:author="a" w:date="2026-01-01T00:00:00Z"/></w:trPr>${cell(para(run_("deleted row")))}</w:tr>` +
      `<w:tr>${cell(para(run_("wide")), `<w:gridSpan w:val="2"/>`)}${cell(para(run_("C")))}</w:tr>` +
      `<w:tr>${cell(para(run_("D")))}${cell(para(run_("E")))}${cell(para(""), "<w:vMerge/>")}</w:tr></w:tbl>`,
    `<w:sdt><w:sdtPr><w:alias w:val="box"/></w:sdtPr><w:sdtContent>${para(run_("inside sdt"))}</w:sdtContent></w:sdt>`,
    para(
      `${run_("Box:")}<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${para(run_(" choice"))}</w:txbxContent></wps:txbx></w:drawing></mc:Choice>` +
        `<mc:Fallback><w:pict><v:textbox><w:txbxContent>${para(run_(" fallback"))}</w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r>`,
    ),
    para(`${run_("&lt;tag&gt; &#x263A;")}<w:r><w:noBreakHyphen/><w:t>end</w:t></w:r>`),
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>`,
  ].join("");
  return rawZip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NAMESPACES}><w:body>${body}</w:body></w:document>`,
    },
    {
      name: "word/_rels/document.xml.rels",
      data:
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rIdImg" Type="${REL}/image" Target="media/image1.png"/>` +
        `<Relationship Id="rIdLink" Type="${REL}/hyperlink" Target="https://example.com" TargetMode="External"/>` +
        `</Relationships>`,
    },
    {
      name: "word/styles.xml",
      data:
        `<?xml version="1.0"?><w:styles ${W}>` +
        `<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Berschrift2"><w:name w:val="heading 2"/></w:style>` +
        `<w:style w:type="paragraph" w:styleId="Heading"><w:name w:val="Heading"/></w:style>` +
        `</w:styles>`,
    },
    {
      name: "word/numbering.xml",
      data:
        `<?xml version="1.0"?><w:numbering ${W}>` +
        `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
        `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
        `</w:numbering>`,
    },
    { name: "word/media/image1.png", data: blankGrayPng(4, 3) },
  ]);
}

async function indexOf(path: string) {
  return readZipIndex(path, statSync(path).size, "docx", { maxEntries: 100, maxTotalBytes: 1 << 30, maxPartBytes: 1 << 30 });
}

async function resolved(model: DocxModel): Promise<unknown[]> {
  const blocks: unknown[] = [];
  for await (const block of docxBlocks(model)) {
    if (block.type !== "source-image") blocks.push(block);
    else blocks.push({ ...block, id: createHash("sha1").update(await docxImage(model, block.id)).digest("hex") });
  }
  return blocks;
}

function bigDocx(paragraphs: number, text: string): Buffer {
  const body = Array.from({ length: paragraphs }, (_, i) => `<w:p><w:r><w:t>${i} ${text}</w:t></w:r></w:p>`).join("");
  return rawZip(docxEntries(body));
}

afterEach(() => vi.restoreAllMocks());

describe("R7: docx memory stays bounded for documents the caps accept", () => {
  const cases: [string, () => string][] = [
    ["contract.docx", () => join(FIXTURES, "contract.docx")],
    ["scanned-report.docx", () => join(FIXTURES, "scanned-report.docx")],
    [
      "a document with styles, numbering, tables, images, fields, revisions and text boxes",
      () => {
        const path = join(mkdtempSync(join(tmpdir(), "docx-rich-")), "rich.docx");
        writeFileSync(path, richDocx());
        return path;
      },
    ],
  ];
  for (const [name, path] of cases) {
    it(`streams the same blocks as the converter for ${name}`, async () => {
      const file = path();
      const converted = await resolved(await convertDocx(readFileSync(file)));
      const streamed = await resolved(await streamDocx(await indexOf(file)));
      expect(converted.length).toBeGreaterThan(0);
      expect(streamed).toEqual(converted);
    });
  }

  it("a docx past the conversion threshold never calls mammoth and still pages to the end", async () => {
    const convert = vi.spyOn(mammoth, "convertToHtml");
    const root = workspace({ "big.docx": bigDocx(30_000, "lorem ipsum") });
    await openDocument({ root, path: "big.docx" });
    const first = await readBlocks({ root, path: "big.docx" }, { cursor: 0 });
    expect(first.blocks[0]).toEqual({ type: "paragraph", text: "0 lorem ipsum" });
    expect(first.nextCursor).toBe(first.blocks.length);
    const last = await readBlocks({ root, path: "big.docx" }, { cursor: 29_990 });
    expect(last.blocks.map((block) => (block.type === "paragraph" ? block.text : ""))).toEqual(
      Array.from({ length: 10 }, (_, i) => `${29_990 + i} lorem ipsum`),
    );
    expect(last.nextCursor).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });

  it("a small docx still goes through mammoth", async () => {
    const convert = vi.spyOn(mammoth, "convertToHtml");
    const root = workspace({ "small.docx": bigDocx(50, "short") });
    await readBlocks({ root, path: "small.docx" }, { cursor: 0 });
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it("peaks under 250 MB RSS and shows the first page within 3 s for a docx at the tag and part caps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docx-rss-"));
    writeFileSync(join(dir, "huge.docx"), bigDocx(41_000, "lorem ipsum dolor sit amet ".repeat(26)));
    const probe = join(dir, "probe.mjs");
    await build({
      stdin: {
        contents: `
          import { openDocument, readBlocks } from ${JSON.stringify(join(PLUGIN_ROOT, "server/documents.ts"))};
          const ref = { root: process.argv[2], path: "huge.docx" };
          const started = performance.now();
          await openDocument(ref);
          const page = await readBlocks(ref, { cursor: 0 });
          const firstPageMs = performance.now() - started;
          const tail = await readBlocks(ref, { cursor: 40_950 });
          console.log(JSON.stringify({ firstPageMs, blocks: page.blocks.length, tail: tail.blocks.length, next: tail.nextCursor, maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
        `,
        resolveDir: PLUGIN_ROOT,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      outfile: probe,
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      logLevel: "silent",
    });
    const { stdout } = await run(process.execPath, [probe, dir], { maxBuffer: 1 << 20 });
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result).toMatchObject({ blocks: 100, tail: 50, next: null });
    expect(result.firstPageMs).toBeLessThan(3000);
    expect(result.maxRssBytes).toBeLessThan(250 * 1024 * 1024);
  }, 120_000);
});
