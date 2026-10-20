import { describe, expect, it } from "vitest";
import { gridReducer, INITIAL_GRID, rangeLabel, reconcileGrid } from "../client/paging";
import { openDocument, readRows } from "../server/documents";
import { streamedWorkbook } from "./fixtures/generators.ts";
import { workspace } from "./helpers";
import { XLSX_MAX_ROWS } from "../shared/limits";

describe("R5: a streamed workbook without a dimension element pages to its end", () => {
  it("the client pages forward through every row although doc.open reports no count", async () => {
    // Each window re-reads the sheet from its start, so the cost grows with the square of the rows;
    // five windows show paging to the end without a count.
    const rows = XLSX_MAX_ROWS * 5;
    const root = workspace({ "stream.xlsx": await streamedWorkbook(rows, 10) });
    const ref = { root, path: "stream.xlsx" };
    const opened = await openDocument(ref);
    if (opened.kind !== "xlsx") throw new Error(`expected xlsx, got ${opened.kind}`);
    expect(opened.sheets[0]).toMatchObject({ rowCount: 0, countsApproximate: true });

    let grid = INITIAL_GRID;
    let seen = 0;
    for (let windows = 0; windows < 10; windows++) {
      grid = reconcileGrid(grid, opened.sheets);
      const window = await readRows(ref, { sheet: grid.sheet, rowOffset: grid.rowOffset, columnOffset: grid.columnOffset });
      expect(window.rows[0]![0]).toBe(`R${grid.rowOffset + 1}C1`);
      seen += window.rows.length;
      if (window.nextRowOffset === null) break;
      grid = gridReducer(grid, { type: "nextRows", offset: window.nextRowOffset });
    }
    expect(seen).toBe(rows);
    expect(grid.rowOffset).toBe(rows - XLSX_MAX_ROWS);
  });

  it("does not claim the lower bound of an unknown row count as the total", async () => {
    const root = workspace({ "stream.xlsx": await streamedWorkbook(500, 10) });
    const first = await readRows({ root, path: "stream.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(first.countsApproximate).toBe(true);
    const label = rangeLabel("rows", 0, first.rows.length, first.rowCount, {
      approximate: first.countsApproximate,
      more: first.nextRowOffset !== null,
    });
    expect(label).toBe("Rows 1-200");
  });
});
