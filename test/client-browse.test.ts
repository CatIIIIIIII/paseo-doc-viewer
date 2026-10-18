import { describe, expect, it } from "vitest";
import { browseRows, filterChips, listFooter, noMatchDetail } from "../client/recent";
import { countGroups, DOCUMENT_GROUPS, filterEntries, groupEntries, matchesQuery, queryTerms } from "../shared/browse";
import { DOCUMENT_KINDS, type DocumentKind } from "../shared/kinds";

const entry = (path: string, kind: DocumentKind, mtimeMs: number) => ({ path, kind, mtimeMs, size: 1 });

const ENTRIES = [
  entry("reports/Q4 Report.pdf", "pdf", 5),
  entry("notes.docx", "docx", 9),
  entry("data/sales.xlsx", "xlsx", 3),
  entry("deck/pitch.pptx", "pptx", 1),
  entry("shots/home.png", "image-raster", 8),
  entry("shots/scan.heic", "image-decoded", 10),
  entry("demo.mp4", "video", 2),
  entry("reports/q3-report.pdf", "pdf", 7),
];

describe("document groups", () => {
  it("puts every kind in one of seven groups, both image kinds in Images and CSV, JSON Lines and Parquet with Excel", () => {
    expect(DOCUMENT_GROUPS).toEqual(["pdf", "word", "excel", "powerpoint", "image", "video", "audio"]);
    const groups = groupEntries(DOCUMENT_KINDS.map((kind, i) => entry(`f${i}`, kind, i)));
    expect(groups.map(({ group, entries }) => [group, entries.length])).toEqual([
      ["pdf", 1],
      ["word", 1],
      ["excel", 4],
      ["powerpoint", 1],
      ["image", 2],
      ["video", 1],
      ["audio", 1],
    ]);
  });

  it("orders groups by type and entries newest first within a group, omitting empty groups", () => {
    const groups = groupEntries([entry("a.pdf", "pdf", 1), entry("b.png", "image-raster", 3), entry("c.pdf", "pdf", 4), entry("d.pdf", "pdf", 4)]);
    expect(groups.map(({ group, entries }) => [group, entries.map((item) => item.path)])).toEqual([
      ["pdf", ["c.pdf", "d.pdf", "a.pdf"]],
      ["image", ["b.png"]],
    ]);
  });

  it("counts every group, including empty ones", () => {
    expect(countGroups(ENTRIES)).toEqual({ pdf: 2, word: 1, excel: 1, powerpoint: 1, image: 2, video: 1, audio: 0 });
    expect(countGroups([])).toEqual({ pdf: 0, word: 0, excel: 0, powerpoint: 0, image: 0, video: 0, audio: 0 });
  });
});

describe("document search", () => {
  it("splits a query into lower-case terms and ignores surrounding space", () => {
    expect(queryTerms("  Q4  Report ")).toEqual(["q4", "report"]);
    expect(queryTerms("   ")).toEqual([]);
  });

  it("matches each term as a case-insensitive substring of the path", () => {
    expect(matchesQuery("reports/Q4 Report.pdf", queryTerms("q4 report"))).toBe(true);
    expect(matchesQuery("reports/Q4 Report.pdf", queryTerms("REPORTS/q4"))).toBe(true);
    expect(matchesQuery("reports/Q4 Report.pdf", queryTerms("q4 sales"))).toBe(false);
    expect(matchesQuery("anything.pdf", [])).toBe(true);
  });

  it("filters by search and type together, keeping the input order", () => {
    const paths = (filter: Parameters<typeof filterEntries>[1]) => filterEntries(ENTRIES, filter).map((item) => item.path);
    expect(paths({})).toEqual(ENTRIES.map((item) => item.path));
    expect(paths({ query: "report" })).toEqual(["reports/Q4 Report.pdf", "reports/q3-report.pdf"]);
    expect(paths({ query: "SHOTS" })).toEqual(["shots/home.png", "shots/scan.heic"]);
    expect(paths({ group: "image" })).toEqual(["shots/home.png", "shots/scan.heic"]);
    expect(paths({ query: "home", group: "image" })).toEqual(["shots/home.png"]);
    expect(paths({ query: "report", group: "word" })).toEqual([]);
    expect(paths({ query: "zzz" })).toEqual([]);
  });
});

describe("documents panel rows", () => {
  const counts = countGroups(ENTRIES);

  it("heads each group with its shown and total counts, entries newest first", () => {
    const rows = browseRows(ENTRIES, { counts, collapsed: new Set(), headers: true });
    expect(rows.map((row) => (row.type === "header" ? `# ${row.group} ${row.shown}/${row.total}` : row.entry.path))).toEqual([
      "# pdf 2/2",
      "reports/q3-report.pdf",
      "reports/Q4 Report.pdf",
      "# word 1/1",
      "notes.docx",
      "# excel 1/1",
      "data/sales.xlsx",
      "# powerpoint 1/1",
      "deck/pitch.pptx",
      "# image 2/2",
      "shots/scan.heic",
      "shots/home.png",
      "# video 1/1",
      "demo.mp4",
    ]);
  });

  it("keeps a collapsed group's header and hides its entries", () => {
    const rows = browseRows(ENTRIES.slice(0, 2), { counts, collapsed: new Set(["pdf"]), headers: true });
    expect(rows).toEqual([
      { type: "header", group: "pdf", shown: 1, total: 2, collapsed: true },
      { type: "header", group: "word", shown: 1, total: 1, collapsed: false },
      { type: "entry", entry: ENTRIES[1] },
    ]);
  });

  it("reports a larger total when the newest-first cap cut a group short", () => {
    const rows = browseRows([ENTRIES[0]], { counts: { ...counts, pdf: 40 }, collapsed: new Set(), headers: true });
    expect(rows[0]).toEqual({ type: "header", group: "pdf", shown: 1, total: 40, collapsed: false });
  });

  it("lists entries without headers or collapsing when one type is selected", () => {
    const pdfs = filterEntries(ENTRIES, { group: "pdf" });
    const rows = browseRows(pdfs, { counts, collapsed: new Set(["pdf"]), headers: false });
    expect(rows.map((row) => (row.type === "entry" ? row.entry.path : row.type))).toEqual(["reports/q3-report.pdf", "reports/Q4 Report.pdf"]);
  });
});

describe("documents panel filter chips", () => {
  it("offers All plus only the types present, with counts", () => {
    const counts = { pdf: 3, word: 0, excel: 2, powerpoint: 0, image: 0, video: 1, audio: 0 };
    expect(filterChips(counts, null)).toEqual([
      { group: null, count: 6 },
      { group: "pdf", count: 3 },
      { group: "excel", count: 2 },
      { group: "video", count: 1 },
    ]);
  });

  it("keeps the selected type even when a search leaves it empty", () => {
    const counts = { pdf: 1, word: 0, excel: 0, powerpoint: 0, image: 0, video: 0, audio: 0 };
    expect(filterChips(counts, "word")).toEqual([
      { group: null, count: 1 },
      { group: "pdf", count: 1 },
      { group: "word", count: 0 },
    ]);
  });
});

describe("documents panel empty and footer text", () => {
  it("says what found nothing", () => {
    expect(noMatchDetail({ query: " Q4 ", group: null }, false)).toBe('No files match "Q4"');
    expect(noMatchDetail({ query: "q4", group: "excel" }, false)).toBe('No spreadsheets and data files match "q4"');
    expect(noMatchDetail({ query: "", group: "image" }, false)).toBe("No images in this workspace");
    expect(noMatchDetail({ query: "", group: "video" }, false)).toBe("No Video files in this workspace");
    expect(noMatchDetail({ query: "", group: "pdf", needsReview: true }, false)).toBe("No PDF files changed since review");
    expect(noMatchDetail({ query: "q4", needsReview: true }, false)).toBe('No files changed since review match "q4"');
  });

  it("warns when the workspace was too large to search completely", () => {
    expect(noMatchDetail({ query: "q4", group: null }, true)).toBe('No files match "q4". Only the first 50,000 entries of this workspace were searched');
  });

  it("describes a capped list as recent documents or recent matches", () => {
    expect(listFooter(50, false)).toBe("Showing the 50 most recently changed");
    expect(listFooter(50, true)).toBe("Showing the 50 most recent matches");
  });
});
