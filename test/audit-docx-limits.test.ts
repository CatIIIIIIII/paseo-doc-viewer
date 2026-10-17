import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDocx, verifyDocx } from "../server/docx";
import { readZipIndex } from "../server/zip";
import { pluginModule, runCapped } from "./capped-child";
import { docxWithDuplicateMainPart, docxWithHiddenMainPart } from "./fixtures/hostile";
import { workspace } from "./helpers";
import { docxEntries } from "./zip-builder";

// Audit (post 0.4.0): loadDocx only takes the mammoth path when verifyEntries counted at most
// 20k tags and 2 MB of XML. The count missed parts mammoth still reads (a main part not named
// *.xml, or a duplicated entry name), so a ~120 KB docx with a 40 MiB main part went to mammoth and
// aborted the process with "JavaScript heap out of memory". verifyDocx now counts and caps the
// main part from _rels/.rels and its related parts whatever their names, and duplicate names are
// refused.

const OFFICE = { maxEntries: 20_000, maxTotalBytes: 128 * 1024 * 1024, maxPartBytes: 32 * 1024 * 1024 };

async function modelKind(zip: Buffer) {
  const root = workspace({ "a.docx": zip });
  const path = join(root, "a.docx");
  const index = await readZipIndex(path, statSync(path).size, "docx", OFFICE);
  return (await loadDocx(index, await verifyDocx(index, 250_000, OFFICE.maxPartBytes))).kind;
}

// 30k paragraphs is ~120k tags: above the 20k mammoth limit, below the 250k open limit.
const PARAGRAPHS = 30_000;

describe("audit: docx conversion limits", () => {
  it("streams a large main part named document.xml (control)", async () => {
    expect(await modelKind(docxWithHiddenMainPart(PARAGRAPHS, "word/document.xml"))).toBe("streamed");
  });

  it("streams a large main part named document.bin", async () => {
    expect(await modelKind(docxWithHiddenMainPart(PARAGRAPHS))).toBe("streamed");
  });

  it("still converts a small main part named document.bin", async () => {
    expect(await modelKind(docxWithHiddenMainPart(10))).toBe("converted");
  });

  it("refuses a duplicate entry name that could hide the part mammoth reads", async () => {
    const zip = docxWithDuplicateMainPart(PARAGRAPHS, docxEntries("<w:p><w:r><w:t>tiny</w:t></w:r></w:p>"));
    await expect(modelKind(zip)).rejects.toThrow(/not a valid \.docx/);
  });

  it("refuses a 40 MiB hidden main part without exhausting a 128 MB heap", async () => {
    const result = await runCapped(
      `import { writeFileSync, mkdtempSync } from "node:fs";
       import { tmpdir } from "node:os";
       import { join } from "node:path";
       import { openDocument } from ${pluginModule("server/documents.ts")};
       import { docxWithHiddenMainPart } from ${pluginModule("test/fixtures/hostile.ts")};
       const root = mkdtempSync(join(tmpdir(), "docx-hidden-"));
       writeFileSync(join(root, "big.docx"), docxWithHiddenMainPart(1_200_000));
       openDocument({ root, path: "big.docx" }).then(() => console.log("opened"), (error) => console.log(error.message));`,
    );
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toMatch(/\[doc:too_large\].*word\/document\.bin is 39 MiB/);
  }, 60_000);
});
