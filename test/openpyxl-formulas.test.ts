import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRows, scanIssues } from "../server/documents";
import { FIXTURES, workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

// openpyxl never calculates, so it writes `<f>..</f><v></v>`: an empty saved result is no saved result.
const ref = () => ({ root: workspace({ "results.xlsx": readFileSync(join(FIXTURES, "openpyxl-formulas.xlsx")) }), path: "results.xlsx" });

describe("formulas saved by openpyxl without a calculated value", () => {
  it("show their formula text in the grid", async () => {
    const window = await readRows(ref(), { sheet: 1, rowOffset: 0, columnOffset: 0 });
    expect(window.rows.slice(1)).toEqual([
      ["gpt-x-mini", '=COUNTIF(results!B:B,"gpt-x-mini")', '=AVERAGEIF(results!B:B,"gpt-x-mini",results!C:C)', '="label "&A2'],
      ["gpt-x", '=COUNTIF(results!B:B,"gpt-x")', "=C2/B2", ""],
    ]);
  });

  it("report no saved result in the cell inspector", async () => {
    const window = await readRows(ref(), { sheet: 1, rowOffset: 2, columnOffset: 2, maxRows: 1, maxColumns: 1, detail: true });
    expect(window.details![0]![0]).toEqual({ type: "n", raw: null, display: "=C2/B2", numberFormat: "General", formula: { kind: "normal", text: "C2/B2", cached: false } });
  });

  it("are listed by the issue check", async () => {
    const result = await scanIssues(ref(), null);
    expect(result.issues.map(({ sheet, row, column, kind }) => [sheet, row, column, kind])).toEqual([
      [1, 1, 1, "missing-result"], [1, 1, 2, "missing-result"], [1, 1, 3, "missing-result"],
      [1, 2, 1, "missing-result"], [1, 2, 2, "missing-result"],
    ]);
  });

  it("keeps an empty string result saved by Excel", async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="str"><f>""</f><v></v></c><c r="B1"><f>1+1</f><v/></c></row>`);
    const root = workspace({ "empty.xlsx": rawZip(xlsxEntries([{ name: "S", xml }])) });
    const window = await readRows({ root, path: "empty.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0, detail: true });
    expect(window.rows[0]).toEqual(["", "=1+1"]);
    expect(window.details![0]!.map((cell) => cell?.formula?.cached)).toEqual([true, false]);
  });
});
