import { describe, expect, it, vi } from "vitest";
import { cardThumbnail, cardThumbnailRetry, hasThumbnail, TURN_THUMBNAIL_MAX_BYTES } from "../client/turn-docs";
import { ERROR_MESSAGES } from "../shared/errors";
import { createThumbnailCache, createThumbnailLoader, gridLayout, pageThumbnailKey, thumbnailWidth, visibleOrder } from "../client/thumbnails";
import { DOCUMENT_KINDS } from "../shared/kinds";
import { THUMBNAIL_MAX_WIDTH_PX, THUMBNAIL_MIN_WIDTH_PX } from "../shared/limits";

const image = (data = "x") => ({ mimeType: "image/png" as const, width: 10, height: 13, data });

function harness(revision = "r1", cache = createThumbnailCache(100, 1_000_000)) {
  const calls: { index: number; resolve(revision?: string): void; reject(error: Error): void }[] = [];
  const loader = createThumbnailLoader({
    identify: (index: number) => ({ key: `doc\0${index}`, revision }),
    cache,
    fetch: (index: number) =>
      new Promise((resolve, reject) => {
        calls.push({ index, resolve: (answered = revision) => resolve({ revision: answered, image: image(`page${index}`) }), reject });
      }),
  });
  return { loader, calls, cache };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("thumbnail grid layout", () => {
  it("uses two or three columns on a phone and more on a desktop", () => {
    expect(gridLayout(366, true).columns).toBe(3);
    expect(gridLayout(220, true).columns).toBe(2);
    expect(gridLayout(100, true).columns).toBe(2);
    const desktop = gridLayout(918, false);
    expect(desktop.columns).toBeGreaterThanOrEqual(5);
    expect(desktop.columns).toBeLessThanOrEqual(8);
    expect(desktop.cellWidth * desktop.columns + desktop.gap * (desktop.columns - 1)).toBeCloseTo(918, 0);
    expect(desktop.rowHeight).toBeGreaterThan(desktop.imageHeight);
  });

  it("requests a few bucketed widths within the RPC bounds", () => {
    expect(thumbnailWidth(118, 3)).toBe(THUMBNAIL_MAX_WIDTH_PX);
    expect(thumbnailWidth(118, 1)).toBe(thumbnailWidth(112, 1));
    expect(thumbnailWidth(10, 1)).toBe(THUMBNAIL_MIN_WIDTH_PX);
    expect(thumbnailWidth(118, 1) % 40).toBe(0);
  });

  it("orders visible pages first, then the next row, then the previous row", () => {
    const layout = { columns: 3, rowHeight: 100 };
    expect(visibleOrder({ ...layout, offset: 200, viewport: 150, count: 60 })).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 3, 4, 5]);
    expect(visibleOrder({ ...layout, offset: 0, viewport: 150, count: 4 })).toEqual([0, 1, 2, 3]);
    expect(visibleOrder({ ...layout, offset: -500, viewport: 0, count: 60 })).toEqual([0, 1, 2]);
    expect(visibleOrder({ ...layout, offset: 0, viewport: 150, count: 0 })).toEqual([]);
  });
});

describe("thumbnail loader", () => {
  it("never runs more than two requests and starts the wanted pages in priority order", async () => {
    const { loader, calls } = harness();
    loader.want([5, 6, 7, 8]);
    expect(calls.map((call) => call.index)).toEqual([5, 6]);
    loader.want([20, 21, 5, 6]);
    calls[0]!.resolve();
    await flush();
    expect(calls.map((call) => call.index)).toEqual([5, 6, 20]);
    expect(loader.state(5)).toEqual({ status: "ready", image: image("page5") });
    calls[1]!.resolve();
    calls[2]!.resolve();
    await flush();
    expect(calls.map((call) => call.index)).toEqual([5, 6, 20, 21]);
  });

  it("stops starting work once closed and ignores pages that are no longer wanted", async () => {
    const { loader, calls } = harness();
    loader.want([0, 1, 2, 3, 4]);
    loader.close();
    calls[0]!.resolve();
    calls[1]!.resolve();
    await flush();
    expect(calls).toHaveLength(2);
    loader.want([9]);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("reuses cached thumbnails across loaders for the same revision and width", async () => {
    const first = harness();
    first.loader.want([0]);
    first.calls[0]!.resolve();
    await flush();
    const second = harness("r1", first.cache);
    second.loader.want([0, 1]);
    expect(second.loader.state(0)?.status).toBe("ready");
    expect(second.calls.map((call) => call.index)).toEqual([1]);
    const rewritten = harness("r2", first.cache);
    rewritten.loader.want([0]);
    expect(rewritten.calls.map((call) => call.index)).toEqual([0]);
  });

  it("drops an answer from a different revision and records failures without retrying them", async () => {
    const { loader, calls } = harness();
    loader.want([0, 1]);
    calls[0]!.resolve("r2");
    calls[1]!.reject(new Error("busy"));
    await flush();
    expect(loader.state(0)).toEqual({ status: "stale" });
    expect(loader.state(1)).toMatchObject({ status: "failed" });
    loader.want([0, 1]);
    expect(calls).toHaveLength(2);
    loader.retry(1);
    expect(calls.map((call) => call.index)).toEqual([0, 1, 1]);
  });

  it("checks each file of a turn card against its own revision and shares page 1 with the page map", async () => {
    const cache = createThumbnailCache(100, 1_000_000);
    const files = [{ path: "a.pdf", revision: "ra" }, { path: "b.png", revision: "rb" }];
    const answers = [{ revision: "ra", image: image("a") }, { revision: "rb-later", image: image("b") }];
    const card = createThumbnailLoader({
      identify: (index) => ({ key: pageThumbnailKey("w", files[index]!.path, 80, 0), revision: files[index]!.revision }),
      cache,
      fetch: async (index) => answers[index]!,
    });
    card.want([0, 1]);
    await flush();
    expect(card.state(0)).toEqual({ status: "ready", image: image("a") });
    expect(card.state(1)).toEqual({ status: "stale" });
    const pageMap = createThumbnailLoader({
      identify: (index) => ({ key: pageThumbnailKey("w", "a.pdf", 80, index), revision: "ra" }),
      cache,
      fetch: () => new Promise(() => {}),
    });
    expect(pageMap.state(0)?.status).toBe("ready");
    expect(pageMap.state(1)).toBeUndefined();
  });

  it("asks a busy daemon again by itself with the card's retry policy, never work that ran out of time, and stops once closed", async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const make = (errors: Record<number, string>) => createThumbnailLoader({
        identify: (index) => ({ key: `doc\0${index}`, revision: "r1" }),
        cache: createThumbnailCache(10, 1_000_000),
        fetch: async (index) => { calls.push(index); throw new Error(errors[index]); },
        retryAfter: cardThumbnailRetry,
      });
      const loader = make({ 0: ERROR_MESSAGES.busy(), 1: ERROR_MESSAGES.tooSlow() });
      loader.want([0, 1]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls.filter((index) => index === 0)).toHaveLength(4);
      expect(calls.filter((index) => index === 1)).toHaveLength(1);
      expect(loader.state(0)).toMatchObject({ status: "failed" });
      expect(loader.state(1)).toMatchObject({ status: "failed" });
      calls.length = 0;
      const closing = make({ 2: ERROR_MESSAGES.busy() });
      closing.want([2]);
      await vi.advanceTimersByTimeAsync(0);
      closing.close();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies subscribers when a thumbnail settles", async () => {
    const { loader, calls } = harness();
    let notified = 0;
    const stop = loader.subscribe(() => notified++);
    loader.want([0]);
    calls[0]!.resolve();
    await flush();
    expect(notified).toBeGreaterThan(0);
    stop();
  });
});

describe("thumbnail cache", () => {
  it("evicts the least recently used entries by count and by size", () => {
    const cache = createThumbnailCache(2, 1_000);
    cache.set("a", image("a"));
    cache.set("b", image("b"));
    cache.get("a");
    cache.set("c", image("c"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    const small = createThumbnailCache(10, 10);
    small.set("big", image("x".repeat(8)));
    small.set("next", image("y".repeat(8)));
    expect(small.get("big")).toBeUndefined();
    expect(small.get("next")).toBeDefined();
    small.set("huge", image("z".repeat(50)));
    expect(small.get("huge")).toBeUndefined();
  });
});

describe("turn card thumbnails", () => {
  it("are drawn for PDFs and images only", () => {
    expect(DOCUMENT_KINDS.filter(hasThumbnail)).toEqual(["pdf", "image-raster", "image-decoded"]);
    expect(cardThumbnail({ kind: "pdf", size: TURN_THUMBNAIL_MAX_BYTES })).toBe(true);
    expect(cardThumbnail({ kind: "pdf", size: TURN_THUMBNAIL_MAX_BYTES + 1 })).toBe(false);
  });

  it("retry a busy daemon a few times, later each time with jitter, and give up on anything else", () => {
    const busy = new Error(ERROR_MESSAGES.busy());
    const low = [1, 2, 3].map((failures) => cardThumbnailRetry(busy, failures, () => 0)!);
    const high = [1, 2, 3].map((failures) => cardThumbnailRetry(busy, failures, () => 0.999)!);
    expect(low).toEqual([2_000, 4_000, 6_000]);
    expect(high.every((delay, i) => delay > low[i]! * 2.9 && delay < low[i]! * 3)).toBe(true);
    expect(cardThumbnailRetry(busy, 4)).toBeNull();
    for (const message of [ERROR_MESSAGES.tooSlow(), ERROR_MESSAGES.pdfPasswordRequired(), "Request failed: Plugin RPC timed out"]) {
      expect(cardThumbnailRetry(new Error(message), 1)).toBeNull();
    }
  });
});
