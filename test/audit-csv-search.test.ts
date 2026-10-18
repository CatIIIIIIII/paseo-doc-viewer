import { describe, expect, it } from "vitest";
import { openDocument, searchDocument } from "../server/documents";
import { wideThenBlankCsv } from "./fixtures/hostile";
import { workspace } from "./helpers";

// Audit (post 0.4.0): CSV Find streamed rows with columnEnd = columnCount and an infinite deadline.
// Every row, even an empty one, allocated and walked a columnCount-wide array, and empty cells never
// reached SearchScan.visit, so the budget was not checked inside a 256 KB chunk. Scratch
// measurements: 100k columns + 8k blank rows (108 KB) blocked the event loop 5.8 s. Find now
// streams only non-empty cells and checks the budget on every row.

describe("audit: CSV search on a wide, mostly blank file", () => {
  it("keeps the event loop responsive and respects the search budget", async () => {
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

  it("stops on blank rows when the budget is spent and resumes to the match after them", async () => {
    const root = workspace({ "blank.csv": `${wideThenBlankCsv(1_000, 5_000)},,needle\n` });
    const first = await searchDocument({ root, path: "blank.csv" }, "needle", null, 0);
    expect(first.matches).toEqual([]);
    expect(first.next).toMatchObject({ unit: 1 });
    let cursor = first.next;
    let found = first.matches;
    for (let calls = 0; cursor && found.length === 0 && calls < 10_000; calls++) {
      const result = await searchDocument({ root, path: "blank.csv" }, "needle", cursor, 5);
      found = result.matches;
      cursor = result.next;
    }
    expect(found).toEqual([expect.objectContaining({ target: { type: "cell", sheet: 0, row: 5_001, column: 2 } })]);
  }, 30_000);
});
