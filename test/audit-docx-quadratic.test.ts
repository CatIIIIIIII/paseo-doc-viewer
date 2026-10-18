import { describe, expect, it } from "vitest";
import { openDocument, readBlocks } from "../server/documents";
import { storedZip } from "./fixtures/hostile";
import { workspace } from "./helpers";
import { docxEntries, rawZip, type RawEntry } from "./zip-builder";

// Reflection probe (2026-10-18): docx-stream.ts elements() and the streaming TOKEN pattern let a
// start tag's attributes run past "<" and an element body run to the end of the part, so a part
// of unclosed tags is rescanned once per tag. Scratch probe of the bare patterns at 32/64/128 KiB:
// elements("Relationship") on "<Relationship " 63/270/1106 ms, elements("w:style") on
// '<w:style a="' 123/429/1740 ms, TOKEN on "<w:p " 542/2147/8578 ms. End to end, a 256 KiB stored
// document.xml of "<w:p " blocked the plugin for 36 s. Relationship parts are read before the
// 250,000-tag cap, and padding without "<" is not counted by it.

const KiB = 1024;
const repeat = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
const STYLES_REL = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
// More than CONVERT_MAX_XML_BYTES of XML, so the document takes the streamed path.
const STREAMED: RawEntry = { name: "customXml/padding.xml", data: "x".repeat(2 * 1024 * KiB + 1) };

function replaced(entries: RawEntry[], name: string, data: string): RawEntry[] {
  return entries.map((entry) => (entry.name === name ? { name, data } : entry));
}

async function stall(entries: RawEntry[], stored = false): Promise<number> {
  const zip = stored ? storedZip(entries.map(({ name, data }) => ({ name, data: data ?? "" }))) : rawZip(entries);
  const root = workspace({ "doc.docx": zip });
  let maxLag = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last);
    last = now;
  }, 10);
  try {
    await openDocument({ root, path: "doc.docx" }).catch(() => {});
    await readBlocks({ root, path: "doc.docx" }, { cursor: 0 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(probe);
  }
  return maxLag;
}

describe("audit: docx streaming reader is quadratic on unclosed tags", () => {
  it("opens a package whose relationships never close without a long stall", async () => {
    const rels = `<Relationships>${repeat("<Relationship ", 256 * KiB)}`;
    // Streamed, so mammoth's own XML parser (quadratic too, see below) is not what is measured.
    expect(await stall(replaced(docxEntries("<w:p/>", [STREAMED]), "_rels/.rels", rels))).toBeLessThan(1000);
  }, 60_000);

  it("reads styles full of unclosed quoted start tags without a long stall", async () => {
    const styles = `<w:styles>${repeat('<w:style a="', 256 * KiB)}`;
    const entries = docxEntries("<w:p><w:r><w:t>x</w:t></w:r></w:p>", [STREAMED, { name: "word/_rels/document.xml.rels", data: STYLES_REL }, { name: "word/styles.xml", data: styles }]);
    expect(await stall(entries)).toBeLessThan(1000);
  }, 60_000);

  // Stored, so the whole part arrives as one 256 KiB chunk (deflated chunks are smaller).
  it("streams a document of start tags that never end without a long stall", async () => {
    const document = `<w:document><w:body>${repeat("<w:p ", 96 * KiB)}`;
    expect(await stall(replaced(docxEntries("", [STREAMED]), "word/document.xml", document), true)).toBeLessThan(1000);
  }, 60_000);

  // Guard, linear today: mammoth escapes "<" in text, so parseHtml sees only tags it generated.
  // Not covered: mammoth's xmldom parser is quadratic on unclosed tags too, but it only runs under
  // CONVERT_MAX_TAGS (20,000) and CONVERT_MAX_XML_BYTES (2 MiB); its worst case measured about 5 s.
  it("converts a paragraph of escaped start tags without a long stall", async () => {
    expect(await stall(docxEntries(`<w:p><w:r><w:t>${repeat("&lt;p ", 512 * KiB)}</w:t></w:r></w:p>`))).toBeLessThan(1000);
  }, 60_000);
});
