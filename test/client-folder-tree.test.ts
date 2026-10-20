import { describe, expect, it } from "vitest";
import {
  ALL_COLLAPSED,
  ALL_EXPANDED,
  folderFiles,
  folderTree,
  isExpanded,
  TOP_EXPANDED,
  toggleFolder,
  type TreeRow,
  treeRows,
} from "../client/folder-tree";
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
    const rows = treeRows(folderTree(files), (path, depth) => isExpanded(TOP_EXPANDED, path, depth));
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

  it("toggles one folder from any starting point, and Expand all or Collapse all start over", () => {
    const opened = toggleFolder(TOP_EXPANDED, "reports/2026/q3");
    expect(isExpanded(opened, "reports/2026/q3", 1)).toBe(true);
    expect(isExpanded(toggleFolder(opened, "reports/2026/q3"), "reports/2026/q3", 1)).toBe(false);
    expect(isExpanded(toggleFolder(TOP_EXPANDED, "assets"), "assets", 0)).toBe(false);
    expect(isExpanded(ALL_EXPANDED, "reports/2026/q3/weekly", 2)).toBe(true);
    expect(isExpanded(ALL_COLLAPSED, "assets", 0)).toBe(false);
    expect(isExpanded(toggleFolder(ALL_COLLAPSED, "assets"), "assets", 0)).toBe(true);
  });

  it("keeps a search's matches and the folders above them", () => {
    const rows = treeRows(folderTree(filterEntries(files, { query: "summary" })), () => true);
    expect(shown(rows)).toEqual(["v reports/2026 (2)", "  v q2 (1)", "    summary.pdf", "  v q3/weekly (1)", "    summary.pdf"]);
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
