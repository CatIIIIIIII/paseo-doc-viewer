import { describe, expect, it } from "vitest";
import { readRows } from "../server/documents";
import { inspectionWorkbook } from "./fixtures/generators.ts";
import { responseBytes, workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

async function forecast() {
  return { root: workspace({ "forecast.xlsx": await inspectionWorkbook() }), path: "forecast.xlsx" };
}

async function cell(ref: { root: string; path: string }, row: number, column: number, sheet = 0) {
  const window = await readRows(ref, { sheet, rowOffset: row, columnOffset: column, maxRows: 1, maxColumns: 1, detail: true });
  return window.details![0]![0];
}

describe("doc.rows returns structured cell metadata on request", () => {
  it("separates a formula from its saved result, raw value and number format", async () => {
    const ref = await forecast();
    expect(await cell(ref, 7, 1)).toEqual({
      type: "n", raw: "165", display: "$165.00", numberFormat: '"$"#,##0.00',
      formula: { kind: "normal", text: "B7*1.1", cached: true },
    });
  });

  it("labels the master of a shared formula and expands its other cells from the master", async () => {
    const ref = await forecast();
    expect((await cell(ref, 2, 3))!.formula).toEqual({ kind: "shared", text: "B3+C3", cached: true, master: "D3", range: "D3:D10" });
    expect(await cell(ref, 4, 3)).toMatchObject({ raw: "260", formula: { kind: "shared", text: "B5+C5", cached: true, master: "D3", masterText: "B3+C3" } });
  });

  it("reports a formula without a saved result instead of a value", async () => {
    const ref = await forecast();
    expect(await cell(ref, 9, 3)).toMatchObject({ type: "n", raw: null, formula: { kind: "shared", text: "B10+C10", cached: false } });
    expect(await cell(ref, 2, 6)).toMatchObject({ raw: null, display: "=SUM(D3:D10)", formula: { kind: "normal", text: "SUM(D3:D10)", cached: false } });
  });

  it("types errors, strings, booleans, percentages and dates", async () => {
    const ref = await forecast();
    expect(await cell(ref, 4, 4)).toMatchObject({ type: "e", raw: "#DIV/0!", display: "#DIV/0!", formula: { text: "C5/0", cached: true } });
    expect(await cell(ref, 6, 4)).toEqual({ type: "e", raw: "#REF!", display: "#REF!", numberFormat: "0.0%" });
    expect(await cell(ref, 2, 0)).toEqual({ type: "s", raw: "North", display: "North", numberFormat: "General" });
    expect(await cell(ref, 3, 6)).toMatchObject({ type: "b", raw: "1", display: "true" });
    expect(await cell(ref, 2, 4)).toMatchObject({ type: "n", raw: "0.19999999999999996", display: "20.0%", numberFormat: "0.0%" });
    expect(await cell(ref, 2, 5)).toMatchObject({ type: "n", raw: "46032", display: "2026-01-10", numberFormat: "yyyy-mm-dd" });
  });

  it("returns null for empty cells, including the blank parts of a merged title", async () => {
    const ref = await forecast();
    expect(await cell(ref, 0, 2)).toBeNull();
    expect(await cell(ref, 4, 6)).toBeNull();
    expect((await readRows(ref, { sheet: 0, rowOffset: 11, columnOffset: 0, detail: true })).details).toEqual([]);
  });

  it("keeps a window of metadata parallel to its rows and omits it unless asked", async () => {
    const ref = await forecast();
    const plain = await readRows(ref, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(plain.details).toBeUndefined();
    const window = await readRows(ref, { sheet: 0, rowOffset: 2, columnOffset: 0, maxColumns: 4, maxRows: 2, detail: true });
    expect(window.rows).toEqual([["North", "100", "120", "220"], ["South", "110", "130", "240"]]);
    expect(window.details!.map((row) => row.map((detail) => detail?.display ?? ""))).toEqual(window.rows);
  });

  it("labels inline strings, cached string results, stored dates and unsupported formula kinds", async () => {
    const xml = worksheetXml(`<row r="1">
      <c r="A1" t="inlineStr"><is><t>inline &amp; text</t></is></c>
      <c r="B1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>
      <c r="C1" t="d"><v>2026-01-14T00:00:00Z</v></c>
      <c r="D1"><f t="dataTable" ref="D1:E2" dt2D="1" r1="A1" r2="B1"/><v>3</v></c>
      <c r="E1"><f t="array" ref="E1:E2">ROW(A1:A2)</f><v>1</v></c>
      <c r="F1"><f t="shared" si="9"/><v>5</v></c></row>`);
    const ref = { root: workspace({ "kinds.xlsx": rawZip(xlsxEntries([{ name: "K", xml }])) }), path: "kinds.xlsx" };
    const window = await readRows(ref, { sheet: 0, rowOffset: 0, columnOffset: 0, detail: true });
    expect(window.details![0]).toEqual([
      { type: "inlineStr", raw: "inline & text", display: "inline & text", numberFormat: "General" },
      { type: "str", raw: "ab", display: "ab", numberFormat: "General", formula: { kind: "normal", text: '"a"&"b"', cached: true } },
      { type: "d", raw: "2026-01-14T00:00:00Z", display: "2026-01-14", numberFormat: "General" },
      { type: "n", raw: "3", display: "3", numberFormat: "General", formula: { kind: "dataTable", text: null, cached: true, range: "D1:E2" } },
      { type: "n", raw: "1", display: "1", numberFormat: "General", formula: { kind: "array", text: "ROW(A1:A2)", cached: true, range: "E1:E2" } },
      { type: "n", raw: "5", display: "5", numberFormat: "General", formula: { kind: "shared", text: null, cached: true } },
    ]);
  });

  it("finds a shared master that lies outside the requested columns and rows", async () => {
    const rows = [`<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B300" si="0">A1+$A$1</f><v>2</v></c></row>`];
    for (let r = 2; r <= 300; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}"><f t="shared" si="0"/></c></row>`);
    const ref = { root: workspace({ "far.xlsx": rawZip(xlsxEntries([{ name: "F", xml: worksheetXml(rows.join("")) }])) }), path: "far.xlsx" };
    expect((await cell(ref, 249, 1))!.formula).toEqual({ kind: "shared", text: "A250+$A$1", cached: false, master: "B1", masterText: "A1+$A$1", range: "B1:B300" });
  });

  it("treats CSV cells as text whose raw value is the displayed value", async () => {
    const ref = { root: workspace({ "plain.csv": 'name,amount\n"Acme, Inc",=SUM(A1)\n' }), path: "plain.csv" };
    const window = await readRows(ref, { sheet: 0, rowOffset: 1, columnOffset: 0, detail: true });
    expect(window.details).toEqual([[{ type: "text", raw: "Acme, Inc", display: "Acme, Inc" }, { type: "text", raw: "=SUM(A1)", display: "=SUM(A1)" }]]);
    const blank = await readRows({ root: workspace({ "gap.csv": "a,,c\n" }), path: "gap.csv" }, { sheet: 0, rowOffset: 0, columnOffset: 0, detail: true });
    expect(blank.details![0]![1]).toBeNull();
  });

  it("counts metadata against the response budget", async () => {
    const big = "x".repeat(2000);
    const rows = Array.from({ length: 200 }, (_, r) =>
      `<row r="${r + 1}">${Array.from({ length: 50 }, (_, c) => `<c t="inlineStr"><is><t>${big}</t></is></c>`).join("")}</row>`).join("");
    const ref = { root: workspace({ "big.xlsx": rawZip(xlsxEntries([{ name: "B", xml: worksheetXml(rows) }])) }), path: "big.xlsx" };
    const window = await readRows(ref, { sheet: 0, rowOffset: 0, columnOffset: 0, detail: true });
    expect(window.nextRowOffset).toBe(window.rows.length);
    expect(window.details).toHaveLength(window.rows.length);
    expect(responseBytes(window)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
