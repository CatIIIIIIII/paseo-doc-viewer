import { describe, expect, it } from "vitest";
import {
  ALL_COLLAPSED,
  ALL_EXPANDED,
  byName,
  folderFiles,
  folderTree,
  isExpanded,
  setExpanded,
  TOP_EXPANDED,
  treeExpansions,
  type TreeExpansion,
  type TreeRow,
  treeRows,
} from "../client/folder-tree";
import { baseName, documentTitle, parentDir } from "../client/format";
import { TREE_MAX_INDENT_LEVELS, treeIndent, treeLayout } from "../client/panel-layout";
import { treeNotice } from "../client/recent";
import { DOCUMENT_SIBLINGS_MAX, siblingWindow } from "../client/siblings";
import { filterEntries } from "../shared/browse";
import { RECENT_MAX_LIMIT } from "../shared/limits";

const files = [
  "notes.docx",
  "Agenda.pdf",
  "out/reports/weekly.pdf",
  "out/reports/metrics.xlsx",
  "reports/2026/q3/weekly/summary.pdf",
  "reports/2026/q3/memo.docx",
  "reports/2026/q2/summary.pdf",
  "assets/b.png",
  "assets/A.png",
].map((path) => ({ path, kind: "pdf" as const, mtimeMs: 1 }));

const shown = (rows: TreeRow<{ path: string }>[]) =>
  rows.map((row) => `${"  ".repeat(row.depth)}${row.type === "folder" ? `${row.expanded ? "v" : ">"} ${row.name} (${row.count})` : row.entry.path.split("/").pop()}`);

describe("folder tree", () => {
  it("lists folders before files, each by name ignoring case, with recursive counts and single-folder chains on one row", () => {
    const tree = folderTree(files);
    expect(tree.count).toBe(files.length);
    expect(shown(treeRows(tree, () => true))).toEqual([
      "v assets (2)",
      "  A.png",
      "  b.png",
      "v out/reports (2)",
      "  metrics.xlsx",
      "  weekly.pdf",
      "v reports/2026 (3)",
      "  v q2 (1)",
      "    summary.pdf",
      "  v q3 (2)",
      "    v weekly (1)",
      "      summary.pdf",
      "    memo.docx",
      "Agenda.pdf",
      "notes.docx",
    ]);
    const chain = treeRows(tree, () => true).find((row) => row.type === "folder" && row.name === "out/reports");
    expect(chain).toMatchObject({ path: "out/reports", depth: 0 });
  });

  it("opens the top level by default, and a closed folder hides everything under it", () => {
    const rows = treeRows(folderTree(files), (chain, depth) => isExpanded(TOP_EXPANDED, chain, depth));
    expect(shown(rows)).toEqual([
      "v assets (2)",
      "  A.png",
      "  b.png",
      "v out/reports (2)",
      "  metrics.xlsx",
      "  weekly.pdf",
      "v reports/2026 (3)",
      "  > q2 (1)",
      "  > q3 (2)",
      "Agenda.pdf",
      "notes.docx",
    ]);
  });

  it("opens or closes one folder from any starting point, and Expand all or Collapse all start over", () => {
    const opened = setExpanded(TOP_EXPANDED, ["reports/2026/q3"], true);
    expect(isExpanded(opened, ["reports/2026/q3"], 1)).toBe(true);
    expect(isExpanded(setExpanded(opened, ["reports/2026/q3"], false), ["reports/2026/q3"], 1)).toBe(false);
    expect(isExpanded(setExpanded(TOP_EXPANDED, ["assets"], false), ["assets"], 0)).toBe(false);
    expect(isExpanded(ALL_EXPANDED, ["reports/2026/q3/weekly"], 2)).toBe(true);
    expect(isExpanded(ALL_COLLAPSED, ["assets"], 0)).toBe(false);
    expect(isExpanded(setExpanded(ALL_COLLAPSED, ["assets"], true), ["assets"], 0)).toBe(true);
  });

  it("keeps a chained row open or closed when a new file splits the chain, and when it forms again", () => {
    const chained = [{ path: "p/other.pdf" }, { path: "p/q/r/deep.pdf" }];
    const split = [...chained, { path: "p/q/new.pdf" }];
    const rowsOf = (paths: { path: string }[], expansion: TreeExpansion) =>
      shown(treeRows(folderTree(paths), (chain, depth) => isExpanded(expansion, chain, depth)));
    const row = treeRows(folderTree(chained), () => true).find((each) => each.type === "folder" && each.name === "q/r");
    expect(row).toMatchObject({ path: "p/q/r", parent: "p", chain: ["p/q", "p/q/r"] });
    const opened = setExpanded(TOP_EXPANDED, ["p/q", "p/q/r"], true);
    expect(rowsOf(chained, opened)).toEqual(["v p (2)", "  v q/r (1)", "    deep.pdf", "  other.pdf"]);
    expect(rowsOf(split, opened)).toEqual(["v p (3)", "  v q (2)", "    v r (1)", "      deep.pdf", "    new.pdf", "  other.pdf"]);
    const closed = setExpanded(opened, ["p/q", "p/q/r"], false);
    expect(rowsOf(split, setExpanded(closed, ["p/q"], true))).toEqual(["v p (3)", "  v q (2)", "    > r (1)", "    new.pdf", "  other.pdf"]);
    expect(rowsOf(chained, setExpanded(closed, ["p/q"], true))).toEqual(["v p (2)", "  > q/r (1)", "  other.pdf"]);
    const top = setExpanded(TOP_EXPANDED, ["out", "out/reports"], false);
    expect(rowsOf([{ path: "out/reports/a.pdf" }, { path: "out/b.pdf" }], setExpanded(top, ["out"], true))).toEqual(["v out (2)", "  > reports (1)", "  b.pdf"]);
  });

  it("keeps open folders per host and workspace up to a cap, and a filter's apart in each", () => {
    const memory = treeExpansions(2);
    const opened = setExpanded(TOP_EXPANDED, ["docs"], true);
    memory.save("host\0a", opened);
    expect(memory.start("host\0a", null)).toBe(opened);
    expect(memory.start("host\0b", null)).toBe(TOP_EXPANDED);
    expect(memory.start("host\0a", '["q"]')).toBe(ALL_EXPANDED);
    expect(memory.key("host\0a", '["q"]')).not.toBe(memory.key("host\0b", '["q"]'));
    expect(memory.key("host\0a", '["q"]')).not.toBe(memory.key("other\0a", '["q"]'));
    memory.save("host\0b", ALL_COLLAPSED);
    memory.save("host\0a", opened);
    memory.save("host\0c", ALL_EXPANDED);
    expect(memory.start("host\0b", null)).toBe(TOP_EXPANDED);
    expect(memory.start("host\0a", null)).toBe(opened);
    expect(memory.start("host\0c", null)).toBe(ALL_EXPANDED);
  });

  it("keeps a search's matches and the folders above them", () => {
    const rows = treeRows(folderTree(filterEntries(files, { query: "summary" })), () => true);
    expect(shown(rows)).toEqual(["v reports/2026 (2)", "  v q2 (1)", "    summary.pdf", "  v q3/weekly (1)", "    summary.pdf"]);
  });

  it("orders numbers in names by value", () => {
    const names = ["run-10.csv", "run-2.csv", "Run-3.csv", "run-1.csv", "run-01.csv", "run.csv", "v1.10", "v1.9", "build-12345678901234567890", "build-9", "10x", "9x"];
    expect([...names].sort(byName)).toEqual([
      "9x", "10x", "build-9", "build-12345678901234567890", "run-01.csv", "run-1.csv", "run-2.csv", "Run-3.csv", "run-10.csv", "run.csv", "v1.9", "v1.10",
    ]);
    const runs = Array.from({ length: 12 }, (_, index) => ({ path: `exports/run-${index + 1}.csv`, kind: "csv" as const, mtimeMs: index }));
    const rows = treeRows(folderTree([...runs].reverse()), () => true);
    expect(folderFiles(rows, "exports/run-2.csv")).toEqual(runs.map((run) => run.path));
    expect(shown(treeRows(folderTree(["q10/a.pdf", "q9/a.pdf"].map((path) => ({ path }))), () => false))).toEqual(["> q9 (1)", "> q10 (1)"]);
  });

  it("keeps a backslash in a file name instead of reading a folder from it", () => {
    const odd = [{ path: "dir/we\\ird.pdf", kind: "pdf" as const, mtimeMs: 1 }, { path: "dir/plain.pdf", kind: "pdf" as const, mtimeMs: 1 }];
    const rows = treeRows(folderTree(odd), () => true);
    expect(shown(rows)).toEqual(["v dir (2)", "  plain.pdf", "  we\\ird.pdf"]);
    expect(baseName("dir/we\\ird.pdf")).toBe("we\\ird.pdf");
    expect(parentDir("dir/we\\ird.pdf")).toBe("dir");
    expect(folderFiles(rows, "dir/we\\ird.pdf")).toEqual(["dir/plain.pdf", "dir/we\\ird.pdf"]);
    expect(documentTitle({ path: "dir/we\\ird.pdf" })).toBe("we\\ird.pdf · dir");
  });

  it("gives a file the files of its own folder as they are shown", () => {
    const rows = treeRows(folderTree(files), () => true);
    expect(folderFiles(rows, "assets/b.png")).toEqual(["assets/A.png", "assets/b.png"]);
    expect(folderFiles(rows, "notes.docx")).toEqual(["Agenda.pdf", "notes.docx"]);
    expect(folderFiles(rows, "reports/2026/q3/memo.docx")).toEqual(["reports/2026/q3/memo.docx"]);
  });
});

describe("tree siblings", () => {
  const many = Array.from({ length: DOCUMENT_SIBLINGS_MAX * 2 }, (_, index) => `f${index}.pdf`);
  it("keep a short folder whole and cut a long one to the limit around the opened file", () => {
    expect(siblingWindow(["a.pdf", "b.pdf"], "b.pdf")).toEqual(["a.pdf", "b.pdf"]);
    expect(siblingWindow(many, "f0.pdf")).toEqual(many.slice(0, DOCUMENT_SIBLINGS_MAX));
    expect(siblingWindow(many, "f99.pdf")).toEqual(many.slice(DOCUMENT_SIBLINGS_MAX));
    const middle = siblingWindow(many, "f60.pdf");
    expect(middle).toHaveLength(DOCUMENT_SIBLINGS_MAX);
    expect(middle.indexOf("f60.pdf")).toBe(DOCUMENT_SIBLINGS_MAX / 2);
  });
});

describe("tree layout", () => {
  it("indents 16 pt a level on desktop and 12 on a phone, up to six levels", () => {
    expect(treeIndent(treeLayout(800, false), 2)).toBe(32);
    expect(treeIndent(treeLayout(390, true), 2)).toBe(24);
    expect(treeIndent(treeLayout(800, false), 20)).toBe(16 * TREE_MAX_INDENT_LEVELS);
  });

  it("keeps 44 pt rows on a phone and drops the size and status words in the explorer sidebar", () => {
    expect(treeLayout(390, true)).toMatchObject({ rowHeight: 44, size: true, status: "short", actionLabels: true });
    expect(treeLayout(900, false)).toMatchObject({ rowHeight: 28, size: true, status: "full" });
    expect(treeLayout(300, false)).toMatchObject({ size: false, status: "none", actionLabels: false });
  });

  it("says when the daemon listed only part of the workspace", () => {
    expect(treeNotice(12, undefined, false)).toBeNull();
    expect(treeNotice(RECENT_MAX_LIMIT, "limit", false)).toBe("Showing the 1,000 most recently changed documents");
    expect(treeNotice(RECENT_MAX_LIMIT, "limit", true)).toBe("Showing the 1,000 most recently changed matches");
    expect(treeNotice(50, "limit", false)).toBe("Showing the 50 most recently changed documents");
    expect(treeNotice(RECENT_MAX_LIMIT, "scan", false)).toBe("Showing the documents in the first 50,000 entries of this workspace");
  });
});
