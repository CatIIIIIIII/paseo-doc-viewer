import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKeys } from "../server/cache";
import { renderPage, renderThumbnail } from "../server/documents";
import { pdfiumStats } from "../server/pdfium";
import { heavy } from "../server/heavy";
import { errorText, ERROR_MESSAGES } from "../shared/errors";
import { docThumbnailRpc } from "../shared/rpc";
import { RPC_DEADLINE_MS, THUMBNAIL_MAX_WIDTH_PX } from "../shared/limits";
import { decode, type Image } from "imagescript";
import { alphaRampPng, noisePng, textPdf } from "./fixtures/generators";
import { nestedFormPdf } from "./fixtures/hostile";
import { decodePng, workspace, workspaceWithFixtures } from "./helpers";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => vi.useRealTimers());

describe("background heavy work", () => {
  it("runs one background job at a time and never takes the last slot from waiting foreground work", async () => {
    const order: string[] = [];
    const gates = Array.from({ length: 5 }, deferred);
    const job = (name: string, gate: ReturnType<typeof deferred>) => async () => { order.push(`start ${name}`); await gate.promise; };
    const first = heavy(job("thumb a", gates[0]!), { lane: "background" });
    const second = heavy(job("thumb b", gates[1]!), { lane: "background" });
    await settle();
    expect(order).toEqual(["start thumb a"]);
    const page = heavy(job("page", gates[2]!));
    await settle();
    expect(order).toEqual(["start thumb a", "start page"]);
    const queuedPage = heavy(job("queued page", gates[3]!));
    gates[0]!.resolve();
    await settle();
    expect(order.at(-1)).toBe("start queued page");
    gates[2]!.resolve();
    await settle();
    expect(order.at(-1)).toBe("start thumb b");
    for (const gate of gates) gate.resolve();
    await Promise.all([first, second, page, queuedPage]);
  });

  it("rejects background work beyond the queue bound instead of piling it up", async () => {
    const gate = deferred();
    const running = [heavy(() => gate.promise), heavy(() => gate.promise)];
    const queued = Array.from({ length: 40 }, () => heavy(async () => "done", { lane: "background" }).catch((error: Error) => error));
    await settle();
    gate.resolve();
    const results = await Promise.all(queued);
    await Promise.all(running);
    const rejected = results.filter((result) => result instanceof Error);
    expect(rejected.length).toBeGreaterThan(0);
    expect(results.filter((result) => result === "done").length).toBeGreaterThan(0);
    expect((rejected[0] as Error).message).toMatch(/busy/);
  });
  it("starts thumbnails of files nobody is reading only when no page map thumbnail waits, and bounds them apart", async () => {
    const order: string[] = [];
    const gate = deferred();
    const job = (name: string) => async () => { order.push(name); await gate.promise; };
    const foreground = heavy(() => gate.promise);
    const runningCard = heavy(job("card 0"), { lane: "idle" });
    const cards = Array.from({ length: 12 }, (_, i) => heavy(job(`card ${i + 1}`), { lane: "idle" }).catch((error: Error) => error));
    const pageMap = Array.from({ length: 3 }, (_, i) => heavy(job(`map ${i}`), { lane: "background" }));
    await settle();
    expect(order).toEqual(["card 0"]);
    gate.resolve();
    await Promise.all([foreground, runningCard, ...pageMap]);
    const results = await Promise.all(cards);
    expect(order.slice(1, 4)).toEqual(["map 0", "map 1", "map 2"]);
    expect(results.filter((result) => result instanceof Error).map((error) => errorText(error))).toEqual(Array(4).fill(errorText(ERROR_MESSAGES.busy())));
  });

  it("stops waiting for the background slot while half the budget is left, so slow means slow", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const fresh = (await import("../server/heavy")).heavy;
    const hung = fresh(() => new Promise(() => {}), { lane: "background" }).catch((error: Error) => error);
    let waitedFor = Number.NaN;
    const started = Date.now();
    const queued = fresh(async () => "ran", { lane: "idle" }).catch((error: Error) => {
      waitedFor = Date.now() - started;
      return error;
    });
    await vi.advanceTimersByTimeAsync(21_000);
    expect(errorText(await queued)).toBe(errorText(ERROR_MESSAGES.busy()));
    expect(waitedFor).toBe(RPC_DEADLINE_MS / 2);
    expect(errorText(await hung)).toBe(errorText(ERROR_MESSAGES.tooSlow()));
  });
});

describe("PDF thumbnails", () => {
  it("renders a small page image within the width bound without filling the shared page cache", async () => {
    const root = workspace({ "report.pdf": await textPdf(["one", "two", "three"]) });
    const before = cacheKeys().length;
    const thumbnail = await renderThumbnail({ root, path: "report.pdf" }, { index: 2, width: 9_999 });
    expect(thumbnail).toMatchObject({ kind: "pdf", index: 2, pageCount: 3 });
    expect(thumbnail.image.width).toBeLessThanOrEqual(THUMBNAIL_MAX_WIDTH_PX);
    expect(decodePng(thumbnail.image.data).width).toBe(thumbnail.image.width);
    expect(cacheKeys().filter((key) => key.includes("report.pdf")).length).toBeLessThanOrEqual(1);
    expect(cacheKeys().length - before).toBeLessThanOrEqual(1);
  });

  it("is unavailable for kinds without a page image and reports missing pages", async () => {
    const root = workspaceWithFixtures("deck.pptx", "statement.pdf");
    await expect(renderThumbnail({ root, path: "deck.pptx" }, { index: 0, width: 160 })).rejects.toThrow(/doc.thumbnail/);
    await expect(renderThumbnail({ root, path: "statement.pdf" }, { index: 999, width: 160 })).rejects.toThrow(/out of range|999/i);
  });

  it("opens a PDF for one call when not kept open, so the document being read stays held", async () => {
    const files = Object.fromEntries(await Promise.all(["viewer", "a", "b", "c", "d", "e"].map(async (name) => [`${name}.pdf`, await textPdf([name])] as const)));
    const root = workspace(files);
    const opens = () => pdfiumStats().opens;
    await renderPage({ root, path: "viewer.pdf" }, { index: 0 });
    const before = opens();
    await renderThumbnail({ root, path: "viewer.pdf" }, { index: 0, width: 80, keepOpen: false });
    expect(opens()).toBe(before);
    for (const name of "abcde") await renderThumbnail({ root, path: `${name}.pdf` }, { index: 0, width: 80, keepOpen: false });
    expect(opens()).toBe(before + 5);
    await renderPage({ root, path: "viewer.pdf" }, { index: 0, maxWidth: 640 });
    expect(opens()).toBe(before + 5);
    for (const name of "abcde") await renderThumbnail({ root, path: `${name}.pdf` }, { index: 0, width: 120 });
    await renderPage({ root, path: "viewer.pdf" }, { index: 0, maxWidth: 480 });
    expect(opens()).toBe(before + 11);
  });

  it("keeps thumbnails in a cache of their own, so asking again neither renders again nor evicts pages", async () => {
    const root = workspace({ "cached.pdf": await textPdf(["cached"]) });
    const opens = () => pdfiumStats().opens;
    const before = opens();
    const pages = cacheKeys().length;
    const first = await renderThumbnail({ root, path: "cached.pdf" }, { index: 0, width: 80, keepOpen: false });
    const again = await renderThumbnail({ root, path: "cached.pdf" }, { index: 0, width: 80, keepOpen: false });
    expect(again.image).toEqual(first.image);
    expect(opens()).toBe(before + 1);
    expect(cacheKeys().length).toBe(pages);
  });

  it("does not try a card thumbnail that ran out of time again at that revision, so PDFium restarts once", async () => {
    const root = workspace({ "slow.pdf": nestedFormPdf(9) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.resetModules();
    const fresh = await import("../server/documents");
    const { pdfiumStats: stats } = await import("../server/pdfium");
    const card = () => fresh.renderThumbnail({ root, path: "slow.pdf" }, { index: 0, width: 80, keepOpen: false }).catch((error: Error) => error);
    const slow = card();
    await realDelay(300);
    await vi.advanceTimersByTimeAsync(RPC_DEADLINE_MS + 1);
    expect(errorText(await slow)).toBe(errorText(ERROR_MESSAGES.tooSlow()));
    vi.useRealTimers();
    const { opens, spawns } = stats();
    expect(errorText(await card())).toBe(errorText(ERROR_MESSAGES.tooSlow()));
    expect(stats()).toMatchObject({ opens, spawns });
  }, 30_000);

  it("bounds the requested width in the RPC schema", () => {
    const input = { workspaceId: "w", path: "a.pdf", index: 0 };
    expect(docThumbnailRpc.input.safeParse({ ...input, width: 160 }).success).toBe(true);
    expect(docThumbnailRpc.input.safeParse({ ...input, width: THUMBNAIL_MAX_WIDTH_PX + 1 }).success).toBe(false);
    expect(docThumbnailRpc.input.safeParse({ ...input, width: 8 }).success).toBe(false);
  });
});

describe("image thumbnails", () => {
  it("fits raster and decoded images inside a square of the requested width", async () => {
    const root = workspaceWithFixtures("photo.png", "photo.tiff", "photo.heic", "photo-lossy.webp");
    for (const path of ["photo.png", "photo.tiff", "photo.heic", "photo-lossy.webp"]) {
      const thumbnail = await renderThumbnail({ root, path }, { index: 0, width: 80 });
      expect(thumbnail.kind).toBe(path === "photo.png" ? "image-raster" : "image-decoded");
      expect(Math.max(thumbnail.image.width, thumbnail.image.height)).toBeLessThanOrEqual(80);
    }
  });

  it("sends opaque images as JPEG and keeps PNG where there is transparency", async () => {
    const root = workspace({ "photo.png": noisePng(400, 300), "overlay.png": alphaRampPng(noisePng(400, 300)) });
    const photo = await renderThumbnail({ root, path: "photo.png" }, { index: 0, width: 80 });
    const overlay = await renderThumbnail({ root, path: "overlay.png" }, { index: 0, width: 80 });
    expect(photo.image).toMatchObject({ mimeType: "image/jpeg", width: 80, height: 60 });
    expect(overlay.image).toMatchObject({ mimeType: "image/png", width: 80, height: 60 });
    expect(decodePng(overlay.image.data).width).toBe(80);
  });

  it("bounds the height of a tall image too, and sends a small image as it is", async () => {
    const small = noisePng(40, 30);
    const root = workspace({ "tall.png": noisePng(60, 600), "small.png": small });
    const tall = await renderThumbnail({ root, path: "tall.png" }, { index: 0, width: 80 });
    expect(tall.image).toMatchObject({ width: 8, height: 80 });
    expect((await decode(Buffer.from(tall.image.data, "base64"))) as Image).toMatchObject({ width: 8, height: 80 });
    const kept = await renderThumbnail({ root, path: "small.png" }, { index: 0, width: 80 });
    expect(kept.image).toMatchObject({ mimeType: "image/png", width: 40, height: 30, data: small.toString("base64") });
    await expect(renderThumbnail({ root, path: "small.png" }, { index: 1, width: 80 })).rejects.toThrow(/out of range|1/i);
  });
});
