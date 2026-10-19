import { describe, expect, it } from "vitest";
import { cacheKeys } from "../server/cache";
import { renderPage, renderThumbnail } from "../server/documents";
import { pdfiumStats } from "../server/pdfium";
import { heavy } from "../server/heavy";
import { docThumbnailRpc } from "../shared/rpc";
import { THUMBNAIL_MAX_WIDTH_PX } from "../shared/limits";
import { decode, type Image } from "imagescript";
import { alphaRampPng, noisePng, textPdf } from "./fixtures/generators";
import { decodePng, workspace, workspaceWithFixtures } from "./helpers";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("background heavy work", () => {
  it("runs one background job at a time and never takes the last slot from waiting foreground work", async () => {
    const order: string[] = [];
    const gates = Array.from({ length: 5 }, deferred);
    const job = (name: string, gate: ReturnType<typeof deferred>) => async () => { order.push(`start ${name}`); await gate.promise; };
    const first = heavy(job("thumb a", gates[0]!), { background: true });
    const second = heavy(job("thumb b", gates[1]!), { background: true });
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
    const queued = Array.from({ length: 40 }, () => heavy(async () => "done", { background: true }).catch((error: Error) => error));
    await settle();
    gate.resolve();
    const results = await Promise.all(queued);
    await Promise.all(running);
    const rejected = results.filter((result) => result instanceof Error);
    expect(rejected.length).toBeGreaterThan(0);
    expect(results.filter((result) => result === "done").length).toBeGreaterThan(0);
    expect((rejected[0] as Error).message).toMatch(/busy/);
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
    for (const name of "abcde") await renderThumbnail({ root, path: `${name}.pdf` }, { index: 0, width: 80 });
    await renderPage({ root, path: "viewer.pdf" }, { index: 0, maxWidth: 480 });
    expect(opens()).toBe(before + 11);
  });

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
