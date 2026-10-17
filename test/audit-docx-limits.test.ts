import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDocx } from "../server/docx";
import { readZipIndex, verifyEntries } from "../server/zip";
import { docxWithDuplicateMainPart, docxWithHiddenMainPart } from "./fixtures/hostile";
import { workspace } from "./helpers";
import { docxEntries } from "./zip-builder";

// Audit (post 0.4.0): loadDocx only takes the mammoth path when verifyEntries counted at most
// 20k tags and 2 MB of XML. The count misses parts mammoth still reads, so a ~120 KB docx with a
// 40 MiB main part goes to mammoth and aborts the process with "JavaScript heap out of memory"
// (measured in a scratch run; RSS grows ~125x the XML size). The host never respawns the plugin.

const OFFICE = { maxEntries: 20_000, maxTotalBytes: 128 * 1024 * 1024, maxPartBytes: 32 * 1024 * 1024 };

async function modelKind(zip: Buffer) {
  const root = workspace({ "a.docx": zip });
  const path = join(root, "a.docx");
  const index = await readZipIndex(path, statSync(path).size, "docx", OFFICE);
  return (await loadDocx(index, await verifyEntries(index, "docx", 250_000))).kind;
}

// 30k paragraphs is ~120k tags: above the 20k mammoth limit, below the 250k open limit.
const PARAGRAPHS = 30_000;

describe("audit: docx conversion limits", () => {
  it("streams a large main part named document.xml (control)", async () => {
    expect(await modelKind(docxWithHiddenMainPart(PARAGRAPHS, "word/document.xml"))).toBe("streamed");
  });

  it.fails("streams a large main part named document.bin (currently converted by mammoth)", async () => {
    expect(await modelKind(docxWithHiddenMainPart(PARAGRAPHS))).toBe("streamed");
  });

  it.fails("does not let a duplicate entry name hide the part mammoth reads (currently converted)", async () => {
    const zip = docxWithDuplicateMainPart(PARAGRAPHS, docxEntries("<w:p><w:r><w:t>tiny</w:t></w:r></w:p>"));
    expect(await modelKind(zip)).toBe("streamed");
  });
});
