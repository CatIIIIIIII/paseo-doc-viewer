import { describe, expect, it } from "vitest";
import { openDocument, readRows } from "../server/documents";
import { storedZip } from "./fixtures/hostile";
import { workspace } from "./helpers";
import { xlsxEntries, worksheetXml } from "./zip-builder";

// Audit (post 0.4.0): xlsx.ts scan() re-ran SHEET_TOKEN over the whole `pending` buffer per read
// chunk. The `<c\b[^>]*>[\s\S]*?<\/c>` alternative backtracks across the chunk once per unclosed
// "<c", so a worksheet of "<c>" with no "</c>" is O(chunk^2) per chunk. Stored parts stream in
// 256 KB chunks: a 256 KiB sheet blocked the event loop ~2.6 s and a 512 KiB sheet ~10.7 s in a
// scratch run. A streamed worksheet part may be up to 32 MiB (XLSX_LIMITS.maxPartBytes), which
// freezes the plugin for minutes while every other RPC times out. scan() now tokenizes with indexOf
// and resumes an unfinished token's search where it stopped.

const openCells = (bytes: number) => "<c>".repeat(Math.floor(bytes / 3));

async function stall(rows: string): Promise<number> {
  const entries = xlsxEntries([{ name: "Data", xml: worksheetXml(rows) }]);
  const zip = storedZip(entries.map((entry) => ({ name: entry.name, data: entry.data ?? "" })));
  const root = workspace({ "book.xlsx": zip });
  await openDocument({ root, path: "book.xlsx" });
  let maxLag = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last);
    last = now;
  }, 10);
  try {
    await readRows({ root, path: "book.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(probe);
  }
  return maxLag;
}

describe("audit: xlsx tokenizer is quadratic on unclosed cells", () => {
  it("reads a 256 KiB stored worksheet of unclosed cells without a long event-loop stall", async () => {
    expect(await stall(`<row r="1">${openCells(256 * 1024)}`)).toBeLessThan(500);
  }, 30_000);

  it("refuses a 4 MiB unclosed cell quickly", async () => {
    expect(await stall(`<row r="1">${openCells(4 * 1024 * 1024 + 3)}`)).toBeLessThan(500);
  }, 30_000);

  it("reads a sheet of start tags that never close without a long stall", async () => {
    expect(await stall(`<row r="1">${"<c ".repeat(1024 * 1024)}`)).toBeLessThan(500);
  }, 30_000);
});
