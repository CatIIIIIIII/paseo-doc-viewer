import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { readBlocks, readMediaChunk, readRows, renderPage } from "../server/documents";
import { MAX_RENDER_EDGE_PX, MAX_RESPONSE_BYTES, MEDIA_MAX_CHUNK_BYTES, RPC_DEADLINE_MS } from "../shared/limits";
import { docBlocksRpc, docPageRpc, docRowsRpc, mediaChunkRpc } from "../shared/rpc";
import { blankGrayPng, deckPptx, fakeMp4, imageHeavyDocx, noisePng } from "./fixtures/generators.ts";
import { responseBytes, timed, workspace, workspaceWithFixtures } from "./helpers";

async function withinBudget<T>(schema: { output: ZodType }, run: () => Promise<T>): Promise<T> {
  const { value, ms } = await timed(run);
  expect(schema.output.safeParse(value).success, "response matches its RPC output schema").toBe(true);
  expect(responseBytes(value), "response bytes").toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  expect(ms, "response time in ms").toBeLessThan(RPC_DEADLINE_MS);
  return value;
}

function expectImageWithinEdge(image: { width: number; height: number }) {
  expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(MAX_RENDER_EDGE_PX);
}

describe("S4: every RPC response fits the relay budget", () => {
  it("S4: a 200 x 200 inch PDF page renders under MAX_RESPONSE_BYTES even when the client asks for 100000 px", async () => {
    const root = workspaceWithFixtures("huge-page.pdf");
    const page = await withinBudget(docPageRpc, () => renderPage({ root, path: "huge-page.pdf" }, { index: 0, maxWidth: 100_000 }));
    if (page.kind !== "pdf") throw new Error(`expected pdf page, got ${page.kind}`);
    expectImageWithinEdge(page.image);
  }, 60_000);

  it("S4: page render of a 10000x10000 image stays under MAX_RESPONSE_BYTES", async () => {
    const root = workspace({ "scan.png": blankGrayPng(10_000, 10_000) });
    const page = await withinBudget(docPageRpc, () => renderPage({ root, path: "scan.png" }, { index: 0 }));
    if (page.kind !== "image-raster") throw new Error(`expected raster image, got ${page.kind}`);
    expect(page).toMatchObject({ sourceWidth: 10_000, sourceHeight: 10_000 });
    expectImageWithinEdge(page.image);
  }, 60_000);

  it("S4: an incompressible 2600x2600 photo larger than the budget is re-encoded under MAX_RESPONSE_BYTES", async () => {
    const photo = noisePng(2600, 2600);
    expect(photo.length).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const root = workspace({ "noise.png": photo });
    const page = await withinBudget(docPageRpc, () => renderPage({ root, path: "noise.png" }, { index: 0 }));
    if (page.kind !== "image-raster") throw new Error(`expected raster image, got ${page.kind}`);
    expectImageWithinEdge(page.image);
  }, 60_000);

  it("S4: a slide carrying three 4 MiB images stays under MAX_RESPONSE_BYTES", async () => {
    const images = [1, 2, 3].map((seed) => noisePng(1200, 1200, seed));
    const deck = await deckPptx([{ title: "Heavy", body: "Three big pictures", images }]);
    const root = workspace({ "heavy.pptx": deck });
    const slide = await withinBudget(docPageRpc, () => renderPage({ root, path: "heavy.pptx" }, { index: 0 }));
    if (slide.kind !== "pptx") throw new Error(`expected pptx slide, got ${slide.kind}`);
    expect(slide.images.length + slide.omittedImages).toBe(3);
  }, 60_000);

  it("S4: docx blocks page through four 4 MiB images with every page under MAX_RESPONSE_BYTES", async () => {
    const images = [1, 2, 3, 4].map((seed) => noisePng(1200, 1200, seed));
    const root = workspace({ "figures.docx": await imageHeavyDocx(images) });
    let cursor: number | null = 0;
    let figures = 0;
    for (let guard = 0; cursor !== null && guard < 20; guard++) {
      const current: number = cursor;
      const page = await withinBudget(docBlocksRpc, () => readBlocks({ root, path: "figures.docx" }, { cursor: current }));
      figures += page.blocks.filter((block) => block.type === "image" || block.type === "omitted-image").length;
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(figures).toBe(4);
  }, 60_000);

  it("S4: a 300-column sheet with a 100000-character cell stays under MAX_RESPONSE_BYTES", async () => {
    const root = workspaceWithFixtures("wide.xlsx");
    await withinBudget(docRowsRpc, () => readRows({ root, path: "wide.xlsx" }, { sheet: 0, rowOffset: 0, columnOffset: 0 }));
  }, 60_000);

  it("S4: media.chunk clamps an oversized length request", async () => {
    const root = workspace({ "recording.mp4": fakeMp4(20 * 1024 * 1024) });
    const chunk = await withinBudget(mediaChunkRpc, () =>
      readMediaChunk({ root, path: "recording.mp4" }, { offset: 0, length: 1_000_000_000 }),
    );
    expect(Buffer.from(chunk.data, "base64").length).toBeLessThanOrEqual(MEDIA_MAX_CHUNK_BYTES);
    expect(chunk.nextOffset).toBe(Buffer.from(chunk.data, "base64").length);
  }, 60_000);
});
