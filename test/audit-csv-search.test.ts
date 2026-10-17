import { describe, expect, it } from "vitest";
import { openDocument, searchDocument } from "../server/documents";
import { wideThenBlankCsv } from "./fixtures/hostile";
import { workspace } from "./helpers";

// Audit (post 0.4.0): CSV Find streams rows with columnEnd = columnCount and an infinite deadline.
// Every row, even an empty one, allocates and walks a columnCount-wide array, and empty cells never
// reach SearchScan.visit, so the budget is not checked and the loop never yields inside a 256 KB
// chunk. Scratch measurements: 100k columns + 8k blank rows (108 KB) blocked the event loop 5.8 s;
// 1M columns + 1k blank rows (1 MB) 7.8 s, with a 200 ms budget. Cost grows as columns x rows, so a
// ~1.2 MB file freezes the plugin process for many minutes (every other RPC times out meanwhile).

describe("audit: CSV search on a wide, mostly blank file", () => {
  it.fails("keeps the event loop responsive and respects the search budget", async () => {
    const root = workspace({ "wide.csv": wideThenBlankCsv(100_000, 2_000) });
    await openDocument({ root, path: "wide.csv" });
    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last);
      last = now;
    }, 10);
    try {
      await searchDocument({ root, path: "wide.csv" }, "needle", null, 200);
    } finally {
      clearInterval(probe);
    }
    expect(maxLag).toBeLessThan(300);
  }, 30_000);
});
