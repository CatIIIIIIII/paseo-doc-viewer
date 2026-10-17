import { describe, expect, it } from "vitest";
import { openDocument, readRows } from "../server/documents";
import { docOpenRpc, docRowsRpc } from "../shared/rpc";
import { workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

// Audit (post 0.4.0): xlsx.ts parseRange/columnIndex and the row "r" attribute are taken at face
// value. Values past Number.MAX_SAFE_INTEGER make the response fail the host's output validation
// (zod .int() requires safe integers), so a workbook with one bogus dimension or cell reference
// cannot be opened at all. Excel's real limits are 1,048,576 rows and 16,384 columns (XFD).

const book = (rows: string, dimension?: string) =>
  workspace({ "book.xlsx": rawZip(xlsxEntries([{ name: "Data", xml: worksheetXml(rows, dimension) }])) });

describe("audit: xlsx dimensions beyond safe integers", () => {
  it.fails("opens a sheet whose dimension row is absurd (currently fails doc.open output validation)", async () => {
    const root = book(`<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>`, "A1:B99999999999999999999");
    const opened = await openDocument({ root, path: "book.xlsx" });
    expect(docOpenRpc.output.safeParse(opened).success).toBe(true);
  });

  it.fails("opens a sheet whose dimension column letters are absurd", async () => {
    const root = book(`<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>`, "A1:ZZZZZZZZZZZZZ1");
    const opened = await openDocument({ root, path: "book.xlsx" });
    expect(docOpenRpc.output.safeParse(opened).success).toBe(true);
  });

  it.fails("reads rows when one cell reference is absurd (currently fails doc.rows output validation)", async () => {
    const root = book(`<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row><row r="99999999999999999999"><c r="A99999999999999999999"><v>1</v></c></row>`);
    const rows = await readRows({ root, path: "book.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(docRowsRpc.output.safeParse(rows).success).toBe(true);
  });
});
