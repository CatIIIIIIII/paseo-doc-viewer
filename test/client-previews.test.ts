import { describe, expect, it } from "vitest";
import { PREVIEWS_MIN_WIDTH, previewGrid } from "../client/panel-layout";
import { holdRevisions, nextRelease, PREVIEW_HOLD_MS, PREVIEW_MAX_BYTES, previewRows, wantsPreview } from "../client/previews";
import { browseRows, type RecentEntry } from "../client/recent";
import { countGroups, type DocumentGroup } from "../shared/browse";

const entry = (path: string, kind: RecentEntry["kind"], mtimeMs = 1): RecentEntry => ({
  path,
  kind,
  size: 10,
  mtimeMs,
  revision: `${mtimeMs}`,
});

describe("preview grid", () => {
  it("shows rows in the explorer sidebar and tiles of about 140 pt elsewhere", () => {
    expect(previewGrid(PREVIEWS_MIN_WIDTH - 1, false, 2)).toBeNull();
    const sidebar = previewGrid(PREVIEWS_MIN_WIDTH, false, 2)!;
    expect(sidebar.columns).toBe(2);
    expect(sidebar.cellWidth).toBeGreaterThanOrEqual(96);
    const wide = previewGrid(1000, false, 1)!;
    expect(wide.cellWidth).toBeGreaterThanOrEqual(120);
    expect(wide.cellWidth).toBeLessThanOrEqual(180);
  });

  it("uses two phone columns under 420 pt and three from there", () => {
    expect(previewGrid(390, true, 3)!.columns).toBe(2);
    expect(previewGrid(452, true, 3)!.columns).toBe(3);
  });

  it("asks for 160 or 240 px with the pixel ratio capped at 2", () => {
    expect(previewGrid(390, true, 1)!.requestWidth).toBe(240);
    expect(previewGrid(500, false, 1)!.requestWidth).toBe(160);
    expect(previewGrid(500, false, 3)!.requestWidth).toBe(240);
  });
});

describe("preview rows", () => {
  it("chunks PDF, slide and image groups into tile rows and leaves the rest as rows", () => {
    const entries = [
      entry("a.pdf", "pdf", 5),
      entry("b.pdf", "pdf", 4),
      entry("c.pdf", "pdf", 3),
      entry("d.docx", "docx", 2),
      entry("e.png", "image-raster", 1),
      entry("f.pptx", "pptx", 1),
    ];
    const rows = browseRows(entries, { counts: countGroups(entries), collapsed: new Set<DocumentGroup>(["image"]), headers: true });
    const items = previewRows(rows, 2);
    expect(items.map((item) => (item.type === "tiles" ? item.entries.map((e) => e.path).join("+") : item.type === "header" ? item.group : item.entry.path))).toEqual([
      "pdf",
      "a.pdf+b.pdf",
      "c.pdf",
      "word",
      "d.docx",
      "powerpoint",
      "f.pptx",
      "image",
    ]);
  });

  it("keeps groups apart in a flat list", () => {
    const items = previewRows(browseRows([entry("a.pdf", "pdf", 2), entry("b.png", "image-raster", 1)], { counts: countGroups([]), collapsed: new Set(), headers: false }), 4);
    expect(items).toHaveLength(2);
  });

  it("previews only files with a thumbnail and under 64 MiB", () => {
    expect(wantsPreview({ kind: "pdf", size: PREVIEW_MAX_BYTES })).toBe(true);
    expect(wantsPreview({ kind: "pdf", size: PREVIEW_MAX_BYTES + 1 })).toBe(false);
    expect(wantsPreview({ kind: "docx", size: 1 })).toBe(false);
  });
});

describe("held revisions", () => {
  it("asks for a new file at once and for a changed one after it held for one poll", () => {
    let held = holdRevisions(new Map(), [{ path: "a", revision: "1" }], 0);
    expect(held.get("a")!.held).toBe("1");
    expect(nextRelease(held, 0)).toBeNull();
    held = holdRevisions(held, [{ path: "a", revision: "2" }], 1_000);
    expect(held.get("a")!.held).toBe("1");
    expect(nextRelease(held, 1_000)).toBe(PREVIEW_HOLD_MS);
    held = holdRevisions(held, [{ path: "a", revision: "3" }], 3_000);
    held = holdRevisions(held, [{ path: "a", revision: "3" }], 3_000 + PREVIEW_HOLD_MS - 1);
    expect(held.get("a")!.held).toBe("1");
    held = holdRevisions(held, [{ path: "a", revision: "3" }], 3_000 + PREVIEW_HOLD_MS);
    expect(held.get("a")!.held).toBe("3");
    expect(holdRevisions(held, [], 0).size).toBe(0);
  });
});
