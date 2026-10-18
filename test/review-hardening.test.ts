// Repro tests from the review-next lane, second pass over fix/hardening. Each `it.fails` documents a
// confirmed bug and passes while it exists.
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDocx, verifyDocx } from "../server/docx";
import { pdfium } from "../server/pdfium";
import { readZipIndex } from "../server/zip";
import { textPdf } from "./fixtures/generators.ts";
import { docxXml, nestedFormPdf } from "./fixtures/hostile";
import { workspace } from "./helpers";
import { rawZip } from "./zip-builder";

const OFFICE = { maxEntries: 20_000, maxTotalBytes: 128 * 1024 * 1024, maxPartBytes: 32 * 1024 * 1024 };
const OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

async function modelKind(zip: Buffer) {
  const root = workspace({ "a.docx": zip });
  const path = join(root, "a.docx");
  const index = await readZipIndex(path, statSync(path).size, "docx", OFFICE);
  return (await loadDocx(index, await verifyDocx(index, 250_000, OFFICE.maxPartBytes))).kind;
}

describe("review-hardening: docx main part", () => {
  // mammoth takes the first officeDocument target that exists; mainDocumentPart takes the first one listed.
  it("counts the part mammoth reads when the first officeDocument target is missing", async () => {
    const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT}" Target="word/missing.xml"/>`
      + `<Relationship Id="rId2" Type="${OFFICE_DOCUMENT}" Target="word/document.bin"/></Relationships>`;
    const zip = rawZip([
      { name: "[Content_Types].xml", data: types },
      { name: "_rels/.rels", data: rels },
      { name: "word/document.bin", data: docxXml(30_000) },
    ]);
    // 30k paragraphs is ~120k tags, above the 20k mammoth limit: the audit's control case streams it.
    expect(await modelKind(zip)).toBe("streamed");
  }, 60_000);
});

describe("review-hardening: PDFium worker", () => {
  it.fails("a timed-out job does not fail an unrelated job that was only queued behind it", async () => {
    const slow = new Uint8Array(nestedFormPdf(9));
    const ok = new Uint8Array(await textPdf(["hello"]));
    await pdfium({ op: "open", key: "rh-slow", bytes: slow });
    const render = pdfium({ op: "render", key: "rh-slow", index: 0, width: 800, height: 800 }, { timeoutMs: 200 });
    const queued = pdfium({ op: "open", key: "rh-ok", bytes: ok });
    await expect(render).rejects.toThrow();
    // The queued open never reached the worker; it could run on the replacement worker.
    await expect(queued).resolves.toEqual({ pageCount: 1 });
  }, 60_000);
});
