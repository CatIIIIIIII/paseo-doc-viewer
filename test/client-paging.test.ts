import { describe, expect, it } from "vitest";
import {
  canRetry,
  clampIndex,
  clampOffset,
  clampZoom,
  columnName,
  fitSize,
  focalOffset,
  gridReducer,
  jumpGrid,
  INITIAL_GRID,
  nextZoomStep,
  pageRequests,
  pinchScale,
  previousZoomStep,
  rangeLabel,
  reconcileGrid,
  renderWidthFor,
  retryPage,
  scaleShift,
  sheetWindow,
  stripItems,
  tapZoom,
  ZOOM_STEPS,
  zoomLabel,
} from "../client/paging";
import { ERROR_MESSAGES } from "../shared/errors";
import { MAX_RENDER_EDGE_PX, XLSX_MAX_COLUMNS } from "../shared/limits";

const pages = (items: ReturnType<typeof stripItems>) =>
  items.map((item) => (item.type === "page" ? item.index + 1 : "..."));

describe("client page strip", () => {
  it("clamps the active index into the document", () => {
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
    expect(clampIndex(3, 0)).toBe(0);
  });

  it("shows every page of a short document", () => {
    expect(pages(stripItems(0, 5))).toEqual([1, 2, 3, 4, 5]);
  });

  it("windows a long document around the active page with first, last, and gaps", () => {
    expect(pages(stripItems(49, 100))).toEqual([1, "...", 47, 48, 49, 50, 51, 52, 53, "...", 100]);
    expect(pages(stripItems(0, 100))).toEqual([1, 2, 3, 4, "...", 100]);
    expect(pages(stripItems(99, 100))).toEqual([1, "...", 97, 98, 99, 100]);
  });

  it("fills a one-page hole instead of showing a gap", () => {
    expect(pages(stripItems(5, 20))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, "...", 20]);
  });

  it("returns nothing for an empty document", () => {
    expect(stripItems(0, 0)).toEqual([]);
  });
});

describe("client page requests", () => {
  it("clamps a stale index to the current revision's count before requesting", () => {
    expect(pageRequests(1, 1)).toEqual({ current: 0, prefetch: null });
    expect(pageRequests(4, 2)).toEqual({ current: 1, prefetch: null });
  });

  it("prefetches the next page only when it exists", () => {
    expect(pageRequests(0, 2)).toEqual({ current: 0, prefetch: 1 });
    expect(pageRequests(1, 2)).toEqual({ current: 1, prefetch: null });
  });

  it("requests nothing for an empty document", () => {
    expect(pageRequests(0, 0)).toEqual({ current: null, prefetch: null });
  });

  it("does not retry out-of-range errors", () => {
    expect(retryPage(0, new Error(ERROR_MESSAGES.outOfRange("Page", 1, 1)))).toBe(false);
    expect(retryPage(0, new Error(ERROR_MESSAGES.outOfRange("Slide", 3, 2)))).toBe(false);
  });

  it("does not retry deterministic document errors, so a bad file costs one render", () => {
    expect(retryPage(0, new Error(ERROR_MESSAGES.tooLargeForBudget("Workbook")))).toBe(false);
  });

  it("offers a manual retry only for transient failures or a stopped viewer", () => {
    expect(canRetry(new Error(ERROR_MESSAGES.pdfPasswordRequired()))).toBe(false);
    expect(canRetry(new Error(ERROR_MESSAGES.tooLargeForBudget("Workbook")))).toBe(false);
    expect(canRetry(new Error("Request failed: Plugin RPC timed out"))).toBe(true);
    expect(canRetry(new Error("Request failed: Plugin process exited: code 1"))).toBe(true);
    expect(canRetry(new Error("socket closed"))).toBe(true);
  });

  it("retries other errors a bounded number of times", () => {
    expect(retryPage(0, new Error("Request timed out"))).toBe(true);
    expect(retryPage(2, new Error("Request timed out"))).toBe(true);
    expect(retryPage(3, new Error("Request timed out"))).toBe(false);
  });
});

describe("client fit width", () => {
  it("requests physical pixels in coarse steps so small resizes reuse the cached render", () => {
    expect(renderWidthFor(0, 2)).toBeNull();
    expect(renderWidthFor(390, 3)).toBe(1280);
    expect(renderWidthFor(400, 3)).toBe(1280);
    expect(renderWidthFor(800, 1)).toBe(1024);
  });

  it("never exceeds the server render edge", () => {
    expect(renderWidthFor(4000, 3)).toBe(MAX_RENDER_EDGE_PX);
  });

  it("requests a sharper render at the zoomed width, still in coarse steps and under the server edge", () => {
    expect(renderWidthFor(390, 3, 1)).toBe(renderWidthFor(390, 3));
    expect(renderWidthFor(390, 3, 2)).toBe(2560);
    expect(renderWidthFor(390, 3, 3)).toBe(3072);
    expect(renderWidthFor(800, 2, 3)).toBe(MAX_RENDER_EDGE_PX);
    expect(renderWidthFor(0, 3, 2)).toBeNull();
  });

  it("zooms in fixed steps from fit to 3x", () => {
    expect(ZOOM_STEPS).toEqual([1, 1.5, 2, 3]);
    expect(ZOOM_STEPS.map(zoomLabel)).toEqual(["Fit", "1.5x", "2x", "3x"]);
  });

  it("clamps a pinched zoom between fit and the largest step, to one decimal", () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(1.83)).toBe(1.8);
    expect(clampZoom(2.96)).toBe(3);
    expect(clampZoom(7)).toBe(3);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("labels a continuous zoom with one decimal and fit as Fit", () => {
    expect(zoomLabel(1.8)).toBe("1.8x");
    expect(zoomLabel(1.83)).toBe("1.8x");
    expect(zoomLabel(1.04)).toBe("Fit");
  });

  it("steps the buttons from a continuous zoom to the next or previous fixed step", () => {
    expect(nextZoomStep(1)).toBe(1.5);
    expect(nextZoomStep(1.8)).toBe(2);
    expect(nextZoomStep(2)).toBe(3);
    expect(nextZoomStep(3)).toBe(3);
    expect(previousZoomStep(1.8)).toBe(1.5);
    expect(previousZoomStep(1.5)).toBe(1);
    expect(previousZoomStep(1)).toBe(1);
    expect(previousZoomStep(2.4)).toBe(2);
  });

  it("limits the live pinch scale so the zoom stays between fit and the largest step", () => {
    expect(pinchScale(100, 150, 1)).toBe(1.5);
    expect(pinchScale(100, 50, 1)).toBe(1);
    expect(pinchScale(100, 50, 2)).toBe(0.5);
    expect(pinchScale(100, 400, 2)).toBe(1.5);
    expect(pinchScale(0, 100, 1)).toBe(1);
  });

  it("shifts a scaled view so the focal point stays put", () => {
    expect(scaleShift(100, 50, 2)).toBe(-50);
    expect(scaleShift(50, 50, 3)).toBe(0);
    expect(scaleShift(0, 50, 1)).toBe(0);
  });

  it("keeps the content under the pinch focal point when the zoom changes", () => {
    expect(focalOffset(0, 100, 2)).toBe(100);
    expect(focalOffset(100, 100, 0.5)).toBe(0);
    expect(focalOffset(300, 50, 1.5)).toBe(475);
    expect(focalOffset(0, 10, 0.5)).toBe(0);
  });

  it("clamps a scroll offset to the scrollable range", () => {
    expect(clampOffset(500, 1000, 400)).toBe(500);
    expect(clampOffset(900, 1000, 400)).toBe(600);
    expect(clampOffset(-10, 1000, 400)).toBe(0);
    expect(clampOffset(50, 300, 400)).toBe(0);
  });

  it("toggles a double tap between fit and 2x", () => {
    expect(tapZoom(1)).toBe(2);
    expect(tapZoom(1.8)).toBe(1);
    expect(tapZoom(3)).toBe(1);
  });

  it("scales an image to the container width keeping its aspect ratio", () => {
    expect(fitSize(300, { width: 600, height: 800 })).toEqual({ width: 300, height: 400 });
    expect(fitSize(0, { width: 600, height: 800 })).toEqual({ width: 0, height: 0 });
  });
});

describe("client sheet window", () => {
  it("pages rows forward with the server's next offset and back through history", () => {
    let grid = gridReducer(INITIAL_GRID, { type: "nextRows", offset: 200 });
    grid = gridReducer(grid, { type: "nextRows", offset: 350 });
    expect(grid.rowOffset).toBe(350);
    grid = gridReducer(grid, { type: "prevRows" });
    expect(grid.rowOffset).toBe(200);
    grid = gridReducer(grid, { type: "prevRows" });
    expect(grid.rowOffset).toBe(0);
    expect(gridReducer(grid, { type: "prevRows" })).toBe(grid);
  });

  it("ignores a missing or non-advancing next offset", () => {
    expect(gridReducer(INITIAL_GRID, { type: "nextRows", offset: null })).toBe(INITIAL_GRID);
    expect(gridReducer(INITIAL_GRID, { type: "nextColumns", offset: 0 })).toBe(INITIAL_GRID);
  });

  it("pages columns independently of rows", () => {
    let grid = gridReducer(INITIAL_GRID, { type: "nextRows", offset: 200 });
    grid = gridReducer(grid, { type: "nextColumns", offset: 50 });
    expect(grid).toMatchObject({ rowOffset: 200, columnOffset: 50 });
    grid = gridReducer(grid, { type: "prevColumns" });
    expect(grid).toMatchObject({ rowOffset: 200, columnOffset: 0 });
  });

  it("resets the window when switching sheets", () => {
    const grid = gridReducer(gridReducer(INITIAL_GRID, { type: "nextRows", offset: 200 }), { type: "sheet", sheet: 2 });
    expect(grid).toEqual({ ...INITIAL_GRID, sheet: 2 });
  });

  it("labels the visible range", () => {
    expect(rangeLabel("rows", 200, 200, 1234)).toBe("Rows 201-400 of 1,234");
    expect(rangeLabel("columns", 0, 12, 12)).toBe("Columns 1-12 of 12");
    expect(rangeLabel("rows", 0, 0, 0)).toBe("No rows");
  });

  it("labels an approximate total as approximate and an open-ended one without a total", () => {
    expect(rangeLabel("rows", 0, 200, 201, { approximate: true, more: true })).toBe("Rows 1-200");
    expect(rangeLabel("rows", 149_800, 201, 150_001, { approximate: true, more: false })).toBe("Rows 149,801-150,001 of about 150,001");
    expect(rangeLabel("rows", 0, 200, 201, { approximate: false, more: true })).toBe("Rows 1-200 of 201");
  });

  it("requests a few screens of columns, at least 8 and at most the server cap", () => {
    const cell = { width: 140, height: 32 };
    expect(sheetWindow({ width: 412, height: 915 }, cell).columns).toBe(8);
    expect(sheetWindow({ width: 1280, height: 400 }, cell).columns).toBe(20);
    expect(sheetWindow({ width: 10_000, height: 100 }, cell).columns).toBe(XLSX_MAX_COLUMNS);
    expect(sheetWindow({ width: 0, height: 0 }, cell)).toEqual({ columns: 8, rowsPerScreen: 1, windowSize: 3 });
  });

  it("keeps the mounted cells of a virtualized page bounded on any screen", () => {
    const cell = { width: 140, height: 32 };
    for (const viewport of [
      { width: 412, height: 915 },
      { width: 915, height: 412 },
      { width: 1920, height: 1080 },
      { width: 2560, height: 1440 },
      { width: 3840, height: 2160 },
    ]) {
      const window = sheetWindow(viewport, cell);
      expect(window.columns * window.rowsPerScreen * window.windowSize).toBeLessThanOrEqual(3000);
    }
    expect(sheetWindow({ width: 412, height: 915 }, cell)).toEqual({ columns: 8, rowsPerScreen: 29, windowSize: 3 });
  });

  it("names spreadsheet columns", () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });
});

describe("sheet view across revisions", () => {
  const sheets = (...counts: [number, number][]) => counts.map(([rowCount, columnCount]) => ({ rowCount, columnCount }));

  it("keeps a position that still exists", () => {
    const state = { ...INITIAL_GRID, sheet: 1, rowOffset: 200, rowHistory: [0] };
    expect(reconcileGrid(state, sheets([10, 5], [500, 5]))).toBe(state);
  });

  it("falls back to the last sheet when the selected sheet was removed", () => {
    const state = { ...INITIAL_GRID, sheet: 2, rowOffset: 200, rowHistory: [0] };
    expect(reconcileGrid(state, sheets([10, 5], [20, 5]))).toEqual({ ...INITIAL_GRID, sheet: 1 });
  });

  it("returns to the first rows when the sheet shrank below the row offset", () => {
    const state = { ...INITIAL_GRID, rowOffset: 400, rowHistory: [0, 200], columnOffset: 50, columnHistory: [0] };
    expect(reconcileGrid(state, sheets([100, 80]))).toEqual({ ...INITIAL_GRID, columnOffset: 50, columnHistory: [0] });
  });

  it("returns to the first columns when the sheet narrowed below the column offset", () => {
    const state = { ...INITIAL_GRID, rowOffset: 200, rowHistory: [0], columnOffset: 50, columnHistory: [0] };
    expect(reconcileGrid(state, sheets([500, 10]))).toEqual({ ...INITIAL_GRID, rowOffset: 200, rowHistory: [0] });
  });

  it("does not clamp against a sheet whose counts are unknown", () => {
    const state = { ...INITIAL_GRID, rowOffset: 200, rowHistory: [0], columnOffset: 50, columnHistory: [0] };
    expect(reconcileGrid(state, [{ rowCount: 0, columnCount: 0, countsApproximate: true }])).toBe(state);
  });

  it("resets to the start of an emptied workbook", () => {
    expect(reconcileGrid({ ...INITIAL_GRID, sheet: 1, rowOffset: 200, rowHistory: [0] }, [])).toEqual(INITIAL_GRID);
  });
});

describe("client grid jumps", () => {
  it("keeps column A in view when the target fits in the first column window", () => {
    expect(jumpGrid({ sheet: 1, row: 42, column: 1 }, 8)).toEqual({ sheet: 1, rowOffset: 42, columnOffset: 0, rowHistory: [0], columnHistory: [] });
    expect(jumpGrid({ sheet: 0, row: 0, column: 7 }, 8)).toMatchObject({ rowOffset: 0, columnOffset: 0, rowHistory: [] });
  });

  it("starts the window at a target past the first columns, with a way back", () => {
    expect(jumpGrid({ sheet: 0, row: 3, column: 8 }, 8)).toMatchObject({ columnOffset: 8, columnHistory: [0] });
  });
});
