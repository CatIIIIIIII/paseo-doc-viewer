import { statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRecent } from "../server/documents";
import { RECENT_MAX_ENTRIES } from "../shared/limits";
import { docsRecentRpc } from "../shared/rpc";
import { forgetScan } from "../server/recent";
import { revisionOf } from "../server/revision";
import { workspace } from "./helpers";

function crowdedWorkspace(): string {
  const files: Record<string, string> = { "archive/invoice-2019.pdf": "%PDF-1.4", "old/notes.docx": "docx" };
  for (let i = 0; i < RECENT_MAX_ENTRIES + 10; i++) files[`shots/shot-${i}.png`] = "png";
  const root = workspace(files);
  utimesSync(join(root, "archive/invoice-2019.pdf"), 1000, 1000);
  utimesSync(join(root, "old/notes.docx"), 2000, 2000);
  return root;
}

describe("R12: docs.recent searches and filters the whole scan, not just the newest page", () => {
  it("finds an old document by name that the newest-first cap leaves out", async () => {
    const root = crowdedWorkspace();
    const newest = await listRecent(root, {});
    expect(newest.entries).toHaveLength(RECENT_MAX_ENTRIES);
    expect(newest.entries.map((entry) => entry.path)).not.toContain("archive/invoice-2019.pdf");
    expect(newest.truncated).toBe(true);

    const found = await listRecent(root, { query: "INVOICE" });
    expect(found.entries.map((entry) => entry.path)).toEqual(["archive/invoice-2019.pdf"]);
    expect(found.truncated).toBe(false);
  });

  it("gives each entry the file's revision, which changes when the file is rewritten", async () => {
    const root = crowdedWorkspace();
    const path = join(root, "old/notes.docx");
    const before = (await listRecent(root, { query: "notes" })).entries[0]!;
    expect(docsRecentRpc.output.shape.entries.element.parse(before).revision).toBe(revisionOf(statSync(path)));
    utimesSync(path, 3000, 3000);
    forgetScan(root);
    const after = (await listRecent(root, { query: "notes" })).entries[0]!;
    expect(after.revision).toBe(revisionOf(statSync(path)));
    expect(after.revision).not.toBe(before.revision);
  });

  it("filters by type before the cap, so an old Word file shows under Word", async () => {
    const root = crowdedWorkspace();
    const word = await listRecent(root, { group: "word" });
    expect(word.entries.map((entry) => entry.path)).toEqual(["old/notes.docx"]);
    const images = await listRecent(root, { group: "image" });
    expect(images.entries.every((entry) => entry.kind === "image-raster")).toBe(true);
    expect(images.truncated).toBe(true);
  });

  it("counts every type that matches the search across the scan, ignoring the type filter", async () => {
    const root = crowdedWorkspace();
    const all = await listRecent(root, { group: "pdf" });
    expect(all.counts).toEqual({ pdf: 1, word: 1, excel: 0, powerpoint: 0, image: RECENT_MAX_ENTRIES + 10, video: 0, audio: 0 });
    const searched = await listRecent(root, { query: "o", group: "pdf" });
    expect(searched.counts).toEqual({ pdf: 1, word: 1, excel: 0, powerpoint: 0, image: RECENT_MAX_ENTRIES + 10, video: 0, audio: 0 });
    const narrow = await listRecent(root, { query: "notes" });
    expect(narrow.counts).toEqual({ pdf: 0, word: 1, excel: 0, powerpoint: 0, image: 0, video: 0, audio: 0 });
  });

  it("returns nothing, not everything, when no document matches", async () => {
    const root = crowdedWorkspace();
    const none = await listRecent(root, { query: "no such file" });
    expect(none.entries).toEqual([]);
    expect(none.truncated).toBe(false);
  });

  it("validates the search input at the RPC boundary", () => {
    expect(docsRecentRpc.input.safeParse({ workspaceId: "ws", query: "report", group: "excel" }).success).toBe(true);
    expect(docsRecentRpc.input.safeParse({ workspaceId: "ws", group: "spreadsheet" }).success).toBe(false);
    expect(docsRecentRpc.input.safeParse({ workspaceId: "ws", query: "x".repeat(201) }).success).toBe(false);
  });
});

describe("docs.recent names matching files it cannot open", () => {
  const root = () => workspace({ "notebooks/analysis.ipynb": "{}", "data/analysis.sqlite": "SQLite format 3", ".analysis-secret": "x", "report.pdf": "%PDF-1.4" });

  it("lists them only when no document matches the search", async () => {
    const result = await listRecent(root(), { query: "analysis" });
    expect(result.entries).toEqual([]);
    expect([...result.unsupported!].sort()).toEqual(["data/analysis.sqlite", "notebooks/analysis.ipynb"]);
    expect(docsRecentRpc.output.parse(result)).toEqual(result);
  });

  it("stays quiet without a query, with a document match, or with no matching file at all", async () => {
    const workspaceRoot = root();
    expect((await listRecent(workspaceRoot, {})).unsupported).toBeUndefined();
    expect((await listRecent(workspaceRoot, { query: "report" })).unsupported).toBeUndefined();
    expect((await listRecent(workspaceRoot, { query: "nothing-here" })).unsupported).toBeUndefined();
    expect((await listRecent(workspaceRoot, { query: "secret" })).unsupported).toBeUndefined();
  });
});
