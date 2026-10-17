import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { openDocument, renderPage, searchDocument } from "../server/documents";
import type { SearchCursor, SearchMatch } from "../shared/search";
import { workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../server/zip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/zip")>();
  return {
    ...actual,
    streamEntry: (...args: Parameters<typeof actual.streamEntry>) => {
      opened.push(args[1]);
      return actual.streamEntry(...args);
    },
  };
});

async function searchAll(root: string, path: string, query: string, budgetMs?: number) {
  let cursor: SearchCursor | null = null;
  const matches: SearchMatch[] = [];
  let calls = 0;
  do {
    const result = await searchDocument({ root, path }, query, cursor, budgetMs);
    calls++;
    matches.push(...result.matches);
    cursor = result.next;
  } while (cursor && calls < 100_000);
  return { matches, calls };
}

describe("search throughput", () => {
  it("finds a single late match in a 10,000-row CSV in one call", async () => {
    const rows = Array.from({ length: 10_000 }, (_, row) => (row === 9_990 ? "id,needle,x" : `id${row},value ${row},x`));
    const root = workspace({ "long.csv": rows.join("\n") });
    const { matches, calls } = await searchAll(root, "long.csv", "needle");
    expect(matches.map((match) => match.target)).toEqual([{ type: "cell", sheet: 0, row: 9_990, column: 1 }]);
    expect(calls).toBe(1);
  });

  it("resumes a CSV search exactly where a short budget stopped it", async () => {
    const rows = Array.from({ length: 400 }, (_, row) => `a${row},needle ${row}`);
    const root = workspace({ "budget.csv": rows.join("\n") });
    const { matches, calls } = await searchAll(root, "budget.csv", "needle", 0);
    expect(calls).toBeGreaterThan(60);
    expect(matches.map((match) => match.target)).toEqual(rows.map((_, row) => ({ type: "cell", sheet: 0, row, column: 1 })));
  });

  it("parses a long xlsx sheet once across many budget-limited calls", async () => {
    const rows = Array.from({ length: 20_000 }, (_, row) =>
      `<row r="${row + 1}"><c r="A${row + 1}" t="inlineStr"><is><t>${row % 1000 === 999 ? "needle" : `row ${row}`}</t></is></c><c r="B${row + 1}"><v>${row}</v></c></row>`).join("");
    const root = workspace({ "long.xlsx": rawZip(xlsxEntries([{ name: "Data", xml: worksheetXml(rows) }, { name: "Tail", xml: worksheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>needle</t></is></c></row>') }])) });
    opened.length = 0;
    const { matches, calls } = await searchAll(root, "long.xlsx", "needle", 5);
    expect(calls).toBeGreaterThan(3);
    expect(matches.map((match) => match.target)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => ({ type: "cell", sheet: 0, row: i * 1000 + 999, column: 0 })),
      { type: "cell", sheet: 1, row: 0, column: 0 },
    ]);
    expect(opened.filter((part) => part === "xl/worksheets/sheet1.xml").length).toBeLessThanOrEqual(2);
  });

  it("returns many dense matches in one call and continues past fifty", async () => {
    const root = workspace({ "dense.csv": Array.from({ length: 200 }, () => "needle,needle").join("\n") });
    const first = await searchDocument({ root, path: "dense.csv" }, "needle");
    expect(first.matches).toHaveLength(50);
    const { matches } = await searchAll(root, "dense.csv", "needle");
    expect(matches).toHaveLength(400);
  });

  it("lets a page render and timers run while a long PDF search is under way", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let page = 0; page < 1_500; page++) {
      const sheet = pdf.addPage();
      for (let line = 0; line < 8; line++) sheet.drawText(`Page ${page} line ${line} with ordinary words that fill the line to make extraction slower`, { font, size: 8, y: 20 + line * 18 });
    }
    const root = workspace({ "long.pdf": await pdf.save() });
    const ref = { root, path: "long.pdf" };
    await openDocument(ref);
    const order: string[] = [];
    const started = Date.now();
    const search = searchDocument(ref, "absent", null, 60_000).then(() => order.push("search"));
    const tick = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - started), 0));
    const render = renderPage(ref, { index: 0, maxWidth: 200 }).then(() => order.push("render"));
    const waited = await tick;
    await Promise.all([search, render]);
    expect(waited).toBeLessThan(150);
    expect(order).toEqual(["render", "search"]);
  }, 30_000);
});
