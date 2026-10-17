import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readCell, readRows } from "../server/documents";
import { errorCode } from "../shared/errors";
import { CELL_FULL_MAX_CHARS, XLSX_MAX_CELL_CHARS } from "../shared/limits";
import { fullValueSummary, hasFullValue, inspectorFields } from "../client/cell-detail";
import { workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

// Model outputs and judge rationales routinely exceed the grid's 2,000-character cut.
const answer = (chars: number) => Array.from({ length: Math.ceil(chars / 10) }, (_, i) => `word${String(i % 100000).padStart(5, "0")} `).join("").slice(0, chars);

async function sharedStringWorkbook(text: string): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Evals");
  sheet.addRow(["id", "output"]);
  sheet.addRow(["case-1", text]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const detailAt = async (root: string, path: string, row: number, column: number) =>
  (await readRows({ root, path }, { sheet: 0, rowOffset: row, columnOffset: column, maxRows: 1, maxColumns: 1, detail: true })).details![0]![0]!;

describe("R17: full cell values on request", () => {
  it("CSV: the grid cuts a long field, the inspector marks it and doc.cell returns all of it", async () => {
    const long = answer(40_000);
    const root = workspace({ "evals.csv": `id,output,score\ncase-1,"${long}",0.5\n` });
    const grid = await readRows({ root, path: "evals.csv" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(grid.rows[1]![1]).toHaveLength(XLSX_MAX_CELL_CHARS);
    const detail = await detailAt(root, "evals.csv", 1, 1);
    expect(detail.truncated).toBe(true);
    expect(hasFullValue(detail)).toBe(true);
    expect(hasFullValue(await detailAt(root, "evals.csv", 1, 2))).toBe(false);
    const full = await readCell({ root, path: "evals.csv" }, { sheet: 0, row: 1, column: 1 });
    expect(full).toEqual({ revision: grid.revision, text: long, format: "text", truncated: false, length: 40_000 });
  });

  it("CSV: values beyond the cap are cut at the cap and say so", async () => {
    const root = workspace({ "huge.csv": `a\n${"z".repeat(CELL_FULL_MAX_CHARS + 5_000)}\n` });
    const full = await readCell({ root, path: "huge.csv" }, { sheet: 0, row: 1, column: 0 });
    expect(full.text).toHaveLength(CELL_FULL_MAX_CHARS);
    expect(full.truncated).toBe(true);
    expect(fullValueSummary(full)).toMatch(/^Showing the first 262,144/);
  });

  it("XLSX: a long shared string is read in full from the workbook", async () => {
    const long = answer(30_000);
    const root = workspace({ "evals.xlsx": await sharedStringWorkbook(long) });
    const detail = await detailAt(root, "evals.xlsx", 1, 1);
    expect(detail.truncated).toBe(true);
    expect(inspectorFields(detail).find((field) => field.label === "Raw value")?.note).toMatch(/Show full value/);
    const full = await readCell({ root, path: "evals.xlsx" }, { sheet: 0, row: 1, column: 1 });
    expect(full).toMatchObject({ text: long, truncated: false, length: 30_000 });
    expect(await detailAt(root, "evals.xlsx", 1, 0)).not.toHaveProperty("truncated");
  });

  it("XLSX: inline strings and formula text results are read in full too", async () => {
    const inline = answer(9_000);
    const result = answer(5_000);
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>${inline}</t></is></c><c r="B1" t="str"><f>A1</f><v>${result}</v></c><c r="C1"><v>42</v></c></row>`);
    const root = workspace({ "inline.xlsx": rawZip(xlsxEntries([{ name: "S", xml }])) });
    expect((await readCell({ root, path: "inline.xlsx" }, { sheet: 0, row: 0, column: 0 })).text).toBe(inline);
    expect((await readCell({ root, path: "inline.xlsx" }, { sheet: 0, row: 0, column: 1 })).text).toBe(result);
    expect((await readCell({ root, path: "inline.xlsx" }, { sheet: 0, row: 0, column: 2 })).text).toBe("42");
    expect(await readCell({ root, path: "inline.xlsx" }, { sheet: 0, row: 5, column: 0 })).toMatchObject({ text: "", length: 0 });
  });

  it("refuses whole-row requests for spreadsheets and documents without cells", async () => {
    const root = workspace({ "a.csv": "x\n", "a.pdf": "%PDF-1.4\n" });
    await expect(readCell({ root, path: "a.csv" }, { sheet: 0, row: 0, column: null })).rejects.toThrow(/not available/);
    let code: string | null = null;
    try {
      await readCell({ root, path: "a.pdf" }, { sheet: 0, row: 0, column: 0 });
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("invalid_request");
  });
});
