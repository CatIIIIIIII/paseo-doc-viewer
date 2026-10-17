import { describe, expect, it } from "vitest";
import { scanIssues, type IssueLimits } from "../server/documents";
import type { DocIssuesOutput } from "../shared/rpc";
import { inspectionWorkbook } from "./fixtures/generators.ts";
import { workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

const UNBOUNDED: IssueLimits = { budgetMs: 60_000, maxRows: Number.POSITIVE_INFINITY, maxIssues: Number.POSITIVE_INFINITY };

async function forecast() {
  return { root: workspace({ "forecast.xlsx": await inspectionWorkbook() }), path: "forecast.xlsx" };
}

async function scanAll(ref: { root: string; path: string }, limits: IssueLimits) {
  const pages: DocIssuesOutput[] = [];
  let cursor: DocIssuesOutput["next"] = null;
  do {
    const page: DocIssuesOutput = await scanIssues(ref, cursor, limits);
    pages.push(page);
    cursor = page.next;
  } while (cursor && pages.length < 100);
  return { pages, issues: pages.flatMap((page) => page.issues) };
}

const EXPECTED = [
  { sheet: 0, row: 2, column: 6, kind: "missing-result", display: "=SUM(D3:D10)", formula: "SUM(D3:D10)" },
  { sheet: 0, row: 4, column: 4, kind: "error", display: "#DIV/0!", formula: "C5/0" },
  { sheet: 0, row: 6, column: 4, kind: "error", display: "#REF!", formula: null },
  { sheet: 0, row: 8, column: 3, kind: "missing-result", display: "", formula: "B9+C9" },
  { sheet: 0, row: 9, column: 3, kind: "missing-result", display: "", formula: "B10+C10" },
];

describe("doc.issues lists error cells and formulas without a saved result, within bounds", () => {
  it("scans every sheet in order and states the rows it inspected", async () => {
    const result = await scanIssues(await forecast(), null);
    expect(result.issues).toEqual(EXPECTED);
    expect(result.inspected).toEqual([{ sheet: 0, fromRow: 0, toRow: 10 }, { sheet: 1, fromRow: 0, toRow: 21 }]);
    expect(result).toMatchObject({ next: null, stopped: null });
  });

  it("stops at the row cap and resumes where it stopped", async () => {
    const ref = await forecast();
    const first = await scanIssues(ref, null, { ...UNBOUNDED, maxRows: 5 });
    expect(first).toMatchObject({ stopped: "rows", inspected: [{ sheet: 0, fromRow: 0, toRow: 5 }], next: { sheet: 0, row: 5, column: 0 } });
    expect(first.issues).toEqual(EXPECTED.slice(0, 2));
    const { issues, pages } = await scanAll(ref, { ...UNBOUNDED, maxRows: 5 });
    expect(issues).toEqual(EXPECTED);
    expect(pages.flatMap((page) => page.inspected)).toEqual([
      { sheet: 0, fromRow: 0, toRow: 5 }, { sheet: 0, fromRow: 5, toRow: 10 }, { sheet: 1, fromRow: 0, toRow: 5 },
      { sheet: 1, fromRow: 5, toRow: 10 }, { sheet: 1, fromRow: 10, toRow: 15 }, { sheet: 1, fromRow: 15, toRow: 20 }, { sheet: 1, fromRow: 20, toRow: 21 },
    ]);
  });

  it("stops at the issue cap inside a row without losing the rest of it", async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="e"><v>#N/A</v></c><c r="B1" t="e"><v>#NAME?</v></c><c r="C1" t="e"><v>#NUM!</v></c></row>`);
    const ref = { root: workspace({ "row.xlsx": rawZip(xlsxEntries([{ name: "R", xml }])) }), path: "row.xlsx" };
    const first = await scanIssues(ref, null, { ...UNBOUNDED, maxIssues: 2 });
    expect(first).toMatchObject({ stopped: "issues", next: { sheet: 0, row: 0, column: 2 }, inspected: [{ sheet: 0, fromRow: 0, toRow: 0 }] });
    const { issues } = await scanAll(ref, { ...UNBOUNDED, maxIssues: 2 });
    expect(issues.map((issue) => issue.display)).toEqual(["#N/A", "#NAME?", "#NUM!"]);
  });

  it("always makes progress when the time budget is spent", async () => {
    const ref = await forecast();
    const first = await scanIssues(ref, null, { ...UNBOUNDED, budgetMs: 0 });
    expect(first.stopped).toBe("time");
    expect(first.next!.row).toBeGreaterThan(0);
    expect((await scanAll(ref, { ...UNBOUNDED, budgetMs: 0 })).issues).toEqual(EXPECTED);
  });

  it("lets timers run during a long scan", async () => {
    const rows = Array.from({ length: 40_000 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}"><v>${r}</v></c><c r="B${r + 1}"><f>A${r + 1}*2</f><v>${r * 2}</v></c></row>`).join("");
    const ref = { root: workspace({ "long.xlsx": rawZip(xlsxEntries([{ name: "L", xml: worksheetXml(rows) }])) }), path: "long.xlsx" };
    const started = Date.now();
    const tick = new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - started), 0));
    const scan = scanIssues(ref, null, UNBOUNDED);
    expect(await tick).toBeLessThan(150);
    expect(await scan).toMatchObject({ issues: [], stopped: null, inspected: [{ sheet: 0, fromRow: 0, toRow: 40_000 }] });
  }, 30_000);

  it("rejects a cursor from another revision and files without formulas", async () => {
    const ref = await forecast();
    await expect(scanIssues(ref, { revision: "old", sheet: 0, row: 0, column: 0 })).rejects.toThrow(/changed/);
    await expect(scanIssues({ root: workspace({ "a.csv": "a,b\n" }), path: "a.csv" }, null)).rejects.toThrow(/Excel workbooks/);
  });
});
