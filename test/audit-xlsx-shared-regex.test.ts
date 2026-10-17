import { describe, expect, it } from "vitest";
import { readRows, searchDocument } from "../server/documents";
import { workspace } from "./helpers";
import { rawZip, worksheetXml, xlsxEntries } from "./zip-builder";

// Audit (post 0.4.0): xlsx.ts scan() is an async generator that yields between exec() calls on the
// module-level SHEET_TOKEN regex, so its position lives in the shared SHEET_TOKEN.lastIndex. A Find
// stream parked between pages (search.ts parkStream) resumes from whatever lastIndex another sheet
// scan left behind. Loading the grid window between two Find pages, which is what clicking a result
// does, makes the next page silently skip matches (rows 51-201 here). Suggested one-line fix: give
// each scan its own regex, e.g. `token = new RegExp(token.source, token.flags)` at the top of scan().

const rows = (n: number) =>
  Array.from({ length: n }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="inlineStr"><is><t>needle-${r + 1}</t></is></c></row>`).join("");

async function matchedRows(root: string, between?: () => Promise<unknown>): Promise<number[]> {
  const seen: number[] = [];
  let cursor = null as Parameters<typeof searchDocument>[2];
  for (let call = 0; call < 4; call++) {
    const result = await searchDocument({ root, path: "book.xlsx" }, "needle", cursor, 10_000);
    for (const match of result.matches) if (match.target.type === "cell") seen.push(match.target.row);
    cursor = result.next;
    if (!cursor) break;
    await between?.();
  }
  return seen;
}

describe("audit: xlsx scans share one regex", () => {
  it("pages Find results contiguously when nothing else reads the workbook (control)", async () => {
    const root = workspace({ "book.xlsx": rawZip(xlsxEntries([{ name: "Data", xml: worksheetXml(rows(3000)) }])) });
    expect(await matchedRows(root)).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });

  it.fails("pages Find results contiguously when the grid loads a window between pages (currently skips rows)", async () => {
    const root = workspace({ "book.xlsx": rawZip(xlsxEntries([{ name: "Data", xml: worksheetXml(rows(3000)) }])) });
    const seen = await matchedRows(root, () => readRows({ root, path: "book.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 }));
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
});
