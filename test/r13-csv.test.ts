import { truncateSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRecent, openDocument, readRows } from "../server/documents";
import { KIND_GROUP } from "../shared/browse";
import { errorCode } from "../shared/errors";
import { kindForPath } from "../shared/kinds";
import { MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { GROUP_LABEL, KIND_ICON } from "../client/format";
import { responseBytes, workspace } from "./helpers";

async function code(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
  } catch (error) {
    return errorCode(error);
  }
  return "resolved";
}

const rows = (root: string, path: string, rowOffset = 0, columnOffset = 0, maxColumns?: number) =>
  readRows({ root, path }, { sheet: 0, rowOffset, columnOffset, maxColumns });

function grid(rowCount: number, columnCount: number, delimiter = ","): string {
  const lines: string[] = [];
  for (let r = 0; r < rowCount; r++) lines.push(Array.from({ length: columnCount }, (_, c) => `r${r}c${c}`).join(delimiter));
  return `${lines.join("\n")}\n`;
}

describe("R13: CSV and TSV open in the sheet grid", () => {
  it("registers .csv and .tsv as one spreadsheet kind", () => {
    expect(kindForPath("data/export.csv")).toBe("csv");
    expect(kindForPath("DATA.TSV")).toBe("csv");
    expect(KIND_GROUP.csv).toBe("excel");
    expect(GROUP_LABEL.excel).toBe("Spreadsheets and data");
    expect(KIND_ICON.csv).toBe("FileSpreadsheet");
  });

  it("opens as a single sheet with exact counts", async () => {
    const root = workspace({ "people.csv": "name,age\nAda,36\nGrace,45\n" });
    const opened = await openDocument({ root, path: "people.csv" });
    if (opened.kind !== "csv") throw new Error(`expected csv, got ${opened.kind}`);
    expect(opened.sheets).toEqual([{ name: "people.csv", rowCount: 3, columnCount: 2, countsApproximate: false }]);
    const window = await rows(root, "people.csv");
    expect(window.kind).toBe("csv");
    expect(window.rows).toEqual([
      ["name", "age"],
      ["Ada", "36"],
      ["Grace", "45"],
    ]);
    expect(window.nextRowOffset).toBeNull();
    expect(window.nextColumnOffset).toBeNull();
  });

  it("handles quotes, escaped quotes, embedded delimiters and newlines, a BOM and CRLF", async () => {
    const text = '﻿id,note,qty\r\n1,"Hello, world",2\r\n2,"She said ""hi""",3\r\n3,"line one\r\nline two",4\r\n4,,\r\n';
    const root = workspace({ "q.csv": text });
    const window = await rows(root, "q.csv");
    expect(window.rows).toEqual([
      ["id", "note", "qty"],
      ["1", "Hello, world", "2"],
      ["2", 'She said "hi"', "3"],
      ["3", "line one\r\nline two", "4"],
      ["4", "", ""],
    ]);
    expect(window.rowCount).toBe(5);
  });

  it("splits .tsv on tabs, not commas", async () => {
    const root = workspace({ "t.tsv": "a,b\tc\n1,5\t2\n" });
    expect((await rows(root, "t.tsv")).rows).toEqual([
      ["a,b", "c"],
      ["1,5", "2"],
    ]);
  });

  it("pads ragged rows, keeps blank lines, and accepts lone CR line endings", async () => {
    const root = workspace({ "r.csv": "a,b,c\r1\r\rx,y\r" });
    const window = await rows(root, "r.csv");
    expect(window.columnCount).toBe(3);
    expect(window.rows).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
      ["", "", ""],
      ["x", "y", ""],
    ]);
  });

  it("reads a last row without a trailing newline", async () => {
    const root = workspace({ "n.csv": "a,b\n1,2" });
    expect((await rows(root, "n.csv")).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("decodes Latin-1 bytes that are not valid UTF-8", async () => {
    const root = workspace({ "l.csv": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a]) });
    expect((await rows(root, "l.csv")).rows).toEqual([["café", "1"]]);
  });

  it("pages rows and columns with the xlsx window caps", async () => {
    const root = workspace({ "big.csv": grid(450, 120) });
    const first = await rows(root, "big.csv");
    expect(first.rowCount).toBe(450);
    expect(first.columnCount).toBe(120);
    expect(first.rows).toHaveLength(XLSX_MAX_ROWS);
    expect(first.rows.every((row) => row.length === XLSX_MAX_COLUMNS)).toBe(true);
    expect(first.nextRowOffset).toBe(XLSX_MAX_ROWS);
    expect(first.nextColumnOffset).toBe(XLSX_MAX_COLUMNS);

    const later = await rows(root, "big.csv", 437, 100, 8);
    expect(later.rows).toHaveLength(13);
    expect(later.rows[0]).toEqual(Array.from({ length: 8 }, (_, c) => `r437c${100 + c}`));
    expect(later.nextRowOffset).toBeNull();
    expect(later.nextColumnOffset).toBe(108);
  });

  it("clips long cells and stops a window at the response budget", async () => {
    const cell = "x".repeat(XLSX_MAX_CELL_CHARS * 3);
    const line = Array.from({ length: XLSX_MAX_COLUMNS }, () => cell).join(",");
    const root = workspace({ "wide.csv": `${Array.from({ length: XLSX_MAX_ROWS }, () => line).join("\n")}\n` });
    const window = await rows(root, "wide.csv");
    expect(window.rows[0]![0]).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(window.rows.length).toBeLessThan(XLSX_MAX_ROWS);
    expect(window.nextRowOffset).toBe(window.rows.length);
    expect(responseBytes(window)).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it("refuses files over 64 MB and binary content with a .csv name", async () => {
    const root = workspace({ "huge.csv": "a,b\n", "bin.csv": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) });
    truncateSync(join(root, "huge.csv"), 64 * 1024 * 1024 + 1);
    expect(await code(() => openDocument({ root, path: "huge.csv" }))).toBe("too_large");
    expect(await code(() => openDocument({ root, path: "bin.csv" }))).toBe("damaged");
  });

  it("rejects a sheet index other than 0", async () => {
    const root = workspace({ "a.csv": "1\n" });
    expect(await code(() => readRows({ root, path: "a.csv" }, { sheet: 1, rowOffset: 0, columnOffset: 0 }))).toBe("out_of_range");
  });

  it("opens an empty file as an empty sheet", async () => {
    const root = workspace({ "e.csv": "" });
    const opened = await openDocument({ root, path: "e.csv" });
    if (opened.kind !== "csv") throw new Error(`expected csv, got ${opened.kind}`);
    expect(opened.sheets[0]).toMatchObject({ rowCount: 0, columnCount: 0 });
    expect((await rows(root, "e.csv")).rows).toEqual([]);
  });

  it("lists CSV and TSV files under the spreadsheet group", async () => {
    const root = workspace({ "a.csv": "1\n", "b.tsv": "2\n", "c.xlsx": "x", "d.txt": "no" });
    const listed = await listRecent(root, { group: "excel" });
    expect(listed.entries.map((entry) => entry.path).sort()).toEqual(["a.csv", "b.tsv", "c.xlsx"]);
    expect(listed.counts.excel).toBe(3);
  });
});
