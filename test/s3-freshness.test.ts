import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRecent, openDocument, renderPage } from "../server/documents";
import { RECENT_MAX_ENTRIES } from "../shared/limits";
import { textPdf } from "./fixtures/generators.ts";
import { workspace } from "./helpers";

async function pageData(root: string, path: string, index = 0): Promise<string> {
  const page = await renderPage({ root, path }, { index });
  if (page.kind !== "pdf") throw new Error(`expected pdf page, got ${page.kind}`);
  return page.image.data;
}

describe("S3: rebuilt documents render fresh", () => {
  it("S3: after an agent rebuilds main.pdf, open and page reflect the new file", async () => {
    const root = workspace({ "main.pdf": await textPdf(["Draft one"]) });
    const before = await openDocument({ root, path: "main.pdf" });
    const beforePage = await pageData(root, "main.pdf");

    writeFileSync(join(root, "main.pdf"), await textPdf(["Final build, page one", "Final build, page two"]));
    const after = await openDocument({ root, path: "main.pdf" });
    const afterPage = await pageData(root, "main.pdf");

    expect(before).toMatchObject({ kind: "pdf", pageCount: 1 });
    expect(after).toMatchObject({ kind: "pdf", pageCount: 2 });
    expect(after.revision).not.toBe(before.revision);
    expect(afterPage).not.toBe(beforePage);
  }, 30_000);

  it("S3: a same-size rebuild with a new mtime still renders fresh", async () => {
    const draft = await textPdf(["AAAA"]);
    const final = await textPdf(["BBBB"]);
    expect(final.length).toBe(draft.length);
    const root = workspace({ "main.pdf": draft });
    utimesSync(join(root, "main.pdf"), new Date(1_000_000), new Date(1_000_000));
    const beforePage = await pageData(root, "main.pdf");

    writeFileSync(join(root, "main.pdf"), final);
    utimesSync(join(root, "main.pdf"), new Date(2_000_000), new Date(2_000_000));
    const afterPage = await pageData(root, "main.pdf");

    expect(afterPage).not.toBe(beforePage);
  }, 30_000);
});

describe("S3: the most recently changed document is one tap away", () => {
  it("S3: docs.recent lists documents newest first and skips non-documents and dependency folders", async () => {
    const root = workspace({
      "notes.txt": "not a document",
      "old.docx": "placeholder",
      "report/main.pdf": await textPdf(["Report"]),
      "deck.pptx": "placeholder",
      "node_modules/pkg/manual.pdf": await textPdf(["Vendored"]),
      ".git/objects/blob.pdf": "%PDF-1.4",
    });
    const stamp = (path: string, seconds: number) => utimesSync(join(root, path), seconds, seconds);
    stamp("old.docx", 1_000);
    stamp("deck.pptx", 2_000);
    stamp("report/main.pdf", 3_000);
    stamp("node_modules/pkg/manual.pdf", 9_000);
    stamp(".git/objects/blob.pdf", 9_000);

    const recent = await listRecent(root, {});
    expect(recent.entries.map((entry) => entry.path)).toEqual(["report/main.pdf", "deck.pptx", "old.docx"]);
    expect(recent.entries[0]).toMatchObject({ kind: "pdf" });
    expect(recent.truncated).toBe(false);
  });

  it("S3: docs.recent caps its result and says so", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < RECENT_MAX_ENTRIES + 25; i++) files[`out/run-${i}.pdf`] = "%PDF-1.4";
    const root = workspace(files);
    const recent = await listRecent(root, { limit: 1_000 });
    expect(recent.entries).toHaveLength(RECENT_MAX_ENTRIES);
    expect(recent.truncated).toBe(true);
  });
});
