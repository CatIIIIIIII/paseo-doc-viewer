import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { searchDocument } from "../server/documents";
import type { SearchCursor, SearchMatch } from "../shared/search";
import { literalPattern } from "../shared/search";
import { workspace, workspaceWithFixtures } from "./helpers";

async function all(root: string, path: string, query: string) {
  let cursor: SearchCursor | null = null;
  const matches: SearchMatch[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const result = await searchDocument({ root, path }, query, cursor);
    expect(result.matches.length).toBeLessThanOrEqual(50);
    matches.push(...result.matches);
    cursor = result.next;
    if (!cursor) return matches;
  }
  throw new Error("Search did not terminate");
}

describe("bounded in-document search", () => {
  it("resumes within dense cells without skipping or duplicating matches", async () => {
    const root = workspace({ "dense.csv": Array.from({ length: 3 }, () => "a ".repeat(103)).join("\n") });
    const matches = await all(root, "dense.csv", "a");
    expect(matches).toHaveLength(309);
    expect(new Set(matches.map((match) => JSON.stringify(match))).size).toBe(309);
  });

  it("reaches later rows and columns, including text beyond the visible window", async () => {
    const rows = Array.from({ length: 19 }, (_, row) => Array.from({ length: 110 }, (_, column) =>
      row === 18 && column === 105 ? "needle" : "value").join(","));
    const root = workspace({ "wide.csv": rows.join("\n") });
    const matches = await all(root, "wide.csv", "NEEDLE");
    expect(matches.map((match) => match.target)).toEqual([{ type: "cell", sheet: 0, row: 18, column: 105 }]);
  });

  it("does not lose rows across column windows with worst-case escaped cell text", async () => {
    // JSON escaping is worst-case six bytes per character. Both column windows
    // must still advance through identical eight-row spans.
    const row = Array.from({ length: 52 }, () => `"${"\u0001".repeat(1990)}needle"`).join(",");
    const root = workspace({ "escaped.csv": Array.from({ length: 9 }, () => row).join("\n") });
    const matches = await all(root, "escaped.csv", "needle");
    expect(matches).toHaveLength(9 * 52);
    expect(new Set(matches.map((match) => JSON.stringify(match.target))).size).toBe(9 * 52);
  });

  it("searches PDF pages beyond the current view and reports selectable-text coverage", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText("First page", { font });
    pdf.addPage().drawText("Needle on the second page", { font });
    const root = workspace({ "pages.pdf": await pdf.save() });
    const result = await all(root, "pages.pdf", "needle");
    expect(result[0].target).toEqual({ type: "page", index: 1 });
    const first = await searchDocument({ root, path: "pages.pdf" }, "needle");
    expect(first.notes.join(" ")).toMatch(/scanned/);
  });

  it("searches Word, slides and spreadsheets without requesting rendered pictures", async () => {
    const root = workspaceWithFixtures("contract.docx", "deck.pptx", "invoices.xlsx");
    for (const path of ["contract.docx", "deck.pptx", "invoices.xlsx"]) {
      const matches = await all(root, path, path.endsWith("pptx") ? "slide" : "a");
      expect(matches.length, path).toBeGreaterThan(0);
    }
  });

  it("rejects stale revision and changed-query cursors", async () => {
    const root = workspace({ "file.csv": "a ".repeat(100) });
    const first = await searchDocument({ root, path: "file.csv" }, "a");
    expect(first.next).not.toBeNull();
    await expect(searchDocument({ root, path: "file.csv" }, "b", first.next)).rejects.toThrow(/search changed/);
    writeFileSync(join(root, "file.csv"), "new file");
    await expect(searchDocument({ root, path: "file.csv" }, "a", first.next)).rejects.toThrow(/changed/);
  });

  it("treats punctuation literally and preserves offsets after Unicode case folding", () => {
    expect([..."a.* [x] a.*".matchAll(literalPattern("a.*"))].map((m) => m.index)).toEqual([0, 8]);
    expect([..."İ x NEEDLE".matchAll(literalPattern("needle"))].map((m) => m.index)).toEqual([4]);
  });
});
