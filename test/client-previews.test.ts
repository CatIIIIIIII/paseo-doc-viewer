import { describe, expect, it, vi } from "vitest";
import { PREVIEWS_MIN_WIDTH, previewGrid } from "../client/panel-layout";
import { createPreviewLoader, holdRevisions, nextRelease, PREVIEW_HOLD_MS, PREVIEW_MAX_BYTES, type PreviewTarget, previewRows, visibleTilePaths, wantsPreview } from "../client/previews";
import { browseRows, type RecentEntry } from "../client/recent";
import { createThumbnailCache } from "../client/thumbnails";
import { countGroups, type DocumentGroup } from "../shared/browse";
import { ERROR_MESSAGES } from "../shared/errors";
import type { DocThumbnailInput, DocThumbnailOutput } from "../shared/rpc";

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

describe("visible tiles", () => {
  it("are the tile rows on screen and the next tile row after each", () => {
    const entries = ["a", "b", "c", "d", "e", "f", "g"].map((name) => entry(`${name}.pdf`, "pdf"));
    const rows = browseRows([...entries, entry("w.docx", "docx")], { counts: countGroups(entries), collapsed: new Set(), headers: true });
    const items = previewRows(rows, 2);
    expect(items.map((item) => item.type)).toEqual(["header", "tiles", "tiles", "tiles", "tiles", "header", "entry"]);
    expect([...visibleTilePaths(items, [0, 1])]).toEqual(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]);
    expect([...visibleTilePaths(items, [4, 5, 6])]).toEqual(["g.pdf"]);
    expect(visibleTilePaths(items, []).size).toBe(0);
  });
});

describe("preview loader", () => {
  const output = (path: string, revision: string): DocThumbnailOutput => ({ kind: "pdf", revision, index: 0, pageCount: 1, image: { mimeType: "image/jpeg", width: 10, height: 13, data: path } });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  function harness(broken: ReadonlySet<string> = new Set(), errorFor: (path: string) => Error = () => new Error("The file is damaged")) {
    const calls: DocThumbnailInput[] = [];
    const fetch = (input: DocThumbnailInput) => {
      calls.push(input);
      // Answers take a few turns, so some are still on the way when the next key is typed.
      return new Promise<DocThumbnailOutput>((resolve, reject) => setTimeout(() => (broken.has(input.path) ? reject(errorFor(input.path)) : resolve(output(input.path, input.revision!))), 0));
    };
    const cache = createThumbnailCache(100, 1_000_000);
    const loader = createPreviewLoader({ workspaceId: "w", width: 160, fetch, cache });
    return { loader, cache, calls, asked: () => calls.map((call) => call.path) };
  }

  it("asks once per path and revision while a search narrows and widens, failures included", async () => {
    const names = ["plan", "pdf-guide", "report", "pd-notes", "q3", "deck-pdf", "summary", "paper", "map", "pdfs"];
    const files: PreviewTarget[] = names.map((name) => ({ path: `${name}.pdf`, revision: "r1" }));
    const { loader, calls, asked } = harness(new Set(["report.pdf", "pdfs.pdf"]));
    const typed = (query: string) => files.filter((file) => file.path.replace(/\.pdf$/, "").includes(query));
    for (const query of ["", "p", "pd", "pdf", "pd", "p", ""]) {
      const targets = typed(query);
      loader.show(targets, new Set(targets.map((target) => target.path)));
      await settle();
    }
    for (let turn = 0; turn < 20; turn++) await settle();
    expect(calls).toHaveLength(files.length);
    expect(new Set(asked()).size).toBe(files.length);
    expect(calls.every((call) => call.keepOpen === false && call.revision === "r1" && call.width === 160)).toBe(true);
    expect(files.map((file) => loader.state(file)?.status)).toEqual(names.map((name) => (name === "report" || name === "pdfs" ? "failed" : "ready")));
  });

  it("asks for the tiles on screen only, and for a rewritten file's new revision once", async () => {
    const files: PreviewTarget[] = ["a", "b", "c", "d", "e", "f"].map((name) => ({ path: `${name}.pdf`, revision: "r1" }));
    const { loader, cache, asked } = harness();
    loader.show(files, new Set(["c.pdf", "d.pdf"]));
    for (let turn = 0; turn < 5; turn++) await settle();
    expect(asked()).toEqual(["c.pdf", "d.pdf"]);
    loader.show(files, new Set(["e.pdf"]));
    loader.show(files, new Set(["c.pdf", "d.pdf"]));
    for (let turn = 0; turn < 5; turn++) await settle();
    expect(asked()).toEqual(["c.pdf", "d.pdf", "e.pdf"]);
    const rewritten = files.map((file) => (file.path === "c.pdf" ? { ...file, revision: "r2" } : file));
    loader.show(rewritten, new Set(["c.pdf", "d.pdf"]));
    for (let turn = 0; turn < 5; turn++) await settle();
    expect(asked()).toEqual(["c.pdf", "d.pdf", "e.pdf", "c.pdf"]);
    expect(loader.state(rewritten[2]!)?.status).toBe("ready");
    // The panel keeps only this key for the last picture of a path; the picture stays in the bounded cache.
    expect(cache.get(loader.cacheKey(files[2]!))).toMatchObject({ type: "image", image: { data: "c.pdf" } });
    expect(loader.cacheKey(files[2]!)).not.toBe(loader.cacheKey(rewritten[2]!));
  });

  it("asks a busy daemon again only once the tile is back on screen", async () => {
    vi.useFakeTimers();
    try {
      const files: PreviewTarget[] = [{ path: "a.pdf", revision: "r1" }, { path: "b.pdf", revision: "r1" }];
      const busy = new Set(["a.pdf"]);
      const { loader, asked } = harness(busy, () => new Error(ERROR_MESSAGES.busy()));
      loader.show(files, new Set(["a.pdf"]));
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.state(files[0]!)?.status).toBe("loading");
      loader.show(files, new Set(["b.pdf"]));
      busy.clear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(asked()).toEqual(["a.pdf", "b.pdf"]);
      loader.show(files, new Set(["a.pdf"]));
      await vi.advanceTimersByTimeAsync(0);
      expect(asked()).toEqual(["a.pdf", "b.pdf", "a.pdf"]);
      expect(loader.state(files[0]!)?.status).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
});
