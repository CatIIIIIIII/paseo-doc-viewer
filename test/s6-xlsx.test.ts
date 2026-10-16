import { describe, expect, it } from "vitest";
import { openDocument, readRows } from "../server/documents";
import { XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { workspaceWithFixtures } from "./helpers";

describe("S6: xlsx renders paged with row and column caps", () => {
  it("S6: invoices.xlsx lists its sheets and renders values, ISO dates, and cached formula results", async () => {
    const root = workspaceWithFixtures("invoices.xlsx");
    const opened = await openDocument({ root, path: "invoices.xlsx" });
    if (opened.kind !== "xlsx") throw new Error(`expected xlsx, got ${opened.kind}`);
    expect(opened.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Invoices", "Notes"]);

    const summary = await readRows({ root, path: "invoices.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(summary.rows[0].slice(0, 4)).toEqual(["Period", "Invoiced", "Paid", "Outstanding"]);
    expect(summary.rows[1].slice(0, 4)).toEqual(["Q1", "24000", "24000", "0"]);
    expect(summary.rows[1][4]).toBe("0");
    expect(summary.nextRowOffset).toBeNull();

    const invoices = await readRows({ root, path: "invoices.xlsx" }, { sheet: 1, rowOffset: 0, columnOffset: 0 });
    expect(invoices.rows[1].slice(0, 3)).toEqual(["INV-1001", "Northwind Analytics", "2026-01-14"]);
  });

  it("S6: a 300-column sheet returns at most XLSX_MAX_COLUMNS columns and pages sideways", async () => {
    const root = workspaceWithFixtures("wide.xlsx");
    const first = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(first.columnCount).toBe(300);
    expect(first.rows.every((row) => row.length <= XLSX_MAX_COLUMNS)).toBe(true);
    expect(first.rows[0][0]).toBe("C1");
    expect(first.nextColumnOffset).toBe(XLSX_MAX_COLUMNS);

    const next = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: XLSX_MAX_COLUMNS });
    expect(next.rows[0][0]).toBe(`C${XLSX_MAX_COLUMNS + 1}`);
  });

  it("S6: a client column window narrows the page and is clamped to XLSX_MAX_COLUMNS", async () => {
    const root = workspaceWithFixtures("wide.xlsx");
    const narrow = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 8, maxColumns: 8 });
    expect(narrow.rows.every((row) => row.length === 8)).toBe(true);
    expect(narrow.rows[0][0]).toBe("C9");
    expect(narrow.nextColumnOffset).toBe(16);

    const wide = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0, maxColumns: 1000 });
    expect(wide.rows.every((row) => row.length === XLSX_MAX_COLUMNS)).toBe(true);
    expect(wide.nextColumnOffset).toBe(XLSX_MAX_COLUMNS);
  });

  it("S6: a 400-row sheet returns at most XLSX_MAX_ROWS rows and pages down", async () => {
    const root = workspaceWithFixtures("wide.xlsx");
    const first = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(first.rowCount).toBe(400);
    expect(first.rows).toHaveLength(XLSX_MAX_ROWS);
    expect(first.nextRowOffset).toBe(XLSX_MAX_ROWS);

    const last = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: XLSX_MAX_ROWS, columnOffset: 0 });
    expect(last.rows[0][1]).toBe(String((XLSX_MAX_ROWS + 1) * 1000 + 2));
  });

  it("S6: a 100000-character cell is truncated to XLSX_MAX_CELL_CHARS", async () => {
    const root = workspaceWithFixtures("wide.xlsx");
    const rows = await readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(rows.rows[1][0].length).toBeLessThanOrEqual(XLSX_MAX_CELL_CHARS);
  });

  it("S6: a text file renamed to .xlsx fails with a not-a-workbook error", async () => {
    const root = workspaceWithFixtures("not-really.xlsx");
    await expect(openDocument({ root, path: "not-really.xlsx" })).rejects.toThrow(/not a valid|unsupported|does not match/i);
  });
});
