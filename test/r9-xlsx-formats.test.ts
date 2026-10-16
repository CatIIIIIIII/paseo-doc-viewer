import { describe, expect, it } from "vitest";
import { readRows } from "../server/documents";
import { formattedWorkbook } from "./fixtures/generators.ts";
import { workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

const STYLES = `<styleSheet>
  <numFmts count="8">
    <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.000"/>
    <numFmt numFmtId="166" formatCode="yyyy-mm-dd"/>
    <numFmt numFmtId="167" formatCode="0.00&quot;"/>
    <numFmt numFmtId="168" formatCode="${"0".repeat(10_000)}"/>
    <numFmt numFmtId="169" formatCode="h:mm:ss"/>
    <numFmt numFmtId="170" formatCode="[h]:mm"/>
    <numFmt numFmtId="171" formatCode="yyyy-mm-dd hh:mm"/>
  </numFmts>
  <cellXfs count="16">
    <xf numFmtId="0"/><xf numFmtId="10"/><xf numFmtId="9"/><xf numFmtId="164"/><xf numFmtId="165"/>
    <xf numFmtId="3"/><xf numFmtId="4"/><xf numFmtId="14"/><xf numFmtId="166"/><xf numFmtId="167"/><xf numFmtId="168"/>
    <xf numFmtId="169"/><xf numFmtId="170"/><xf numFmtId="171"/><xf numFmtId="20"/><xf numFmtId="45"/>
  </cellXfs>
</styleSheet>`;

async function row(cells: string): Promise<string[]> {
  const xml = worksheetXml(`<row r="1">${cells}</row>`);
  const root = workspace({ "formats.xlsx": rawZip(xlsxEntries([{ name: "F", xml }], [{ name: "xl/styles.xml", data: STYLES }])) });
  const window = await readRows({ root, path: "formats.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
  return window.rows[0]!;
}

const cell = (style: number, value: string | number) => `<c s="${style}"><v>${value}</v></c>`;

describe("R9: xlsx numbers follow their number format", () => {
  it("applies percent, currency, fixed decimals and thousands separators", async () => {
    expect(await row([cell(1, 0.1234), cell(2, 0.5), cell(3, 1234.5), cell(4, 2), cell(5, 1234567), cell(6, 1234567.891)].join(""))).toEqual([
      "12.34%",
      "50%",
      "$1,234.50",
      "2.000",
      "1,234,567",
      "1,234,567.89",
    ]);
  });

  it("keeps dates as ISO dates for built-in and custom date formats", async () => {
    expect(await row([cell(7, 46036), cell(8, 46036.75)].join(""))).toEqual(["2026-01-14", "2026-01-14"]);
  });

  it("renders times, durations and date-times through their format code", async () => {
    expect(await row([cell(11, 0.5104166666666666), cell(12, 1.5), cell(13, 46036.75), cell(14, 0.75), cell(15, 181 / 86400)].join(""))).toEqual([
      "12:15:00",
      "36:00",
      "2026-01-14 18:00",
      "18:00",
      "03:01",
    ]);
  });

  it("applies the 1904 date system to date-times", async () => {
    const xml = worksheetXml(`<row r="1">${cell(13, 46036.75)}${cell(8, 46036)}</row>`);
    const entries = xlsxEntries([{ name: "F", xml }], [{ name: "xl/styles.xml", data: STYLES }]).map((entry) =>
      entry.name === "xl/workbook.xml" ? { ...entry, data: String(entry.data).replace("<sheets>", '<workbookPr date1904="1"/><sheets>') } : entry,
    );
    const root = workspace({ "mac.xlsx": rawZip(entries) });
    const window = await readRows({ root, path: "mac.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.rows[0]).toEqual(["2030-01-15 18:00", "2030-01-15"]);
  });

  it("shows General numbers without float noise and keeps long integers whole", async () => {
    expect(await row([cell(0, 0.1 + 0.2), cell(0, 1 / 3), cell(0, 123456789012), cell(0, -0.5), cell(0, "1E-10")].join(""))).toEqual([
      "0.3",
      "0.333333333333333",
      "123456789012",
      "-0.5",
      "1e-10",
    ]);
  });

  it("falls back to General when a format code cannot be parsed, is longer than Excel allows, or the style is unknown", async () => {
    expect(await row([cell(9, 0.1 + 0.2), cell(10, 7.25), cell(42, 7.5)].join(""))).toEqual(["0.3", "7.25", "7.5"]);
  });

  it("formats a workbook written by a spreadsheet library", async () => {
    const book = await formattedWorkbook([
      { value: 0.1234, numFmt: "0.00%" },
      { value: -1234.5, numFmt: "#,##0.00_);[Red]\\(#,##0.00\\)" },
      { value: 1234.5, numFmt: "[$€-407] #,##0.00" },
      { value: 0.1 + 0.2 },
      { value: new Date("2026-01-14T00:00:00Z"), numFmt: "dd/mm/yyyy" },
    ]);
    const root = workspace({ "book.xlsx": book });
    const window = await readRows({ root, path: "book.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.rows[0]).toEqual(["12.34%", "(1,234.50)", "€ 1,234.50", "0.3", "2026-01-14"]);
  });
});
