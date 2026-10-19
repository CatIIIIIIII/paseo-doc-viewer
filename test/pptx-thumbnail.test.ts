import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode, type Image } from "imagescript";
import { describe, expect, it, vi } from "vitest";
import { renderThumbnail } from "../server/documents";
import { thumbnailCacheKeys } from "../server/thumbnails";
import { thumbnailAnswer } from "../client/thumbnails";
import { deckPptx, noisePng, solidPng } from "./fixtures/generators";
import { workspace, workspaceWithFixtures } from "./helpers";

vi.mock("node:child_process", () => {
  const refuse = () => {
    throw new Error("pptx previews run no external process");
  };
  return { spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

async function deckThumbnail(root: string, path: string, width = 160) {
  const thumbnail = await renderThumbnail({ root, path }, { index: 0, width });
  if (thumbnail.kind !== "pptx") throw new Error(`expected a deck preview, got ${thumbnail.kind}`);
  return thumbnail;
}

const jpeg = async (width: number, height: number) => Buffer.from(await ((await decode(noisePng(width, height))) as Image).encodeJPEG(80));
const wmf = Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0]);

describe("pptx first-slide previews", () => {
  it("use the picture saved with the deck first, bounded on both edges", async () => {
    const saved = { name: "docProps/thumbnail.jpeg", data: await jpeg(256, 192) };
    const root = workspace({ "saved.pptx": await deckPptx([{ title: "Q3", body: "x", images: [solidPng(40, 40, [255, 0, 0])] }], saved) });
    const thumbnail = await deckThumbnail(root, "saved.pptx");
    expect(thumbnail).toMatchObject({ slideCount: 1, preview: { type: "image", source: "saved-thumbnail" } });
    if (thumbnail.preview.type !== "image") throw new Error("expected an image");
    expect(thumbnail.preview.image).toMatchObject({ mimeType: "image/jpeg", width: 160, height: 120 });
  });

  it("skip a WMF thumbnail and fall back to slide 1's first picture, then to its title", async () => {
    const saved = { name: "docProps/thumbnail.wmf", data: wmf };
    const root = workspace({
      "picture.pptx": await deckPptx([{ title: "Cover", body: "x", images: [noisePng(400, 300)] }, { title: "Two", body: "y" }], saved),
      "titled.pptx": await deckPptx([{ title: "Quarterly &amp; review", body: "First body line", titlePlaceholder: true }]),
      "blank.pptx": await deckPptx([{ title: "", body: "" }]),
    });
    expect(await deckThumbnail(root, "picture.pptx")).toMatchObject({ slideCount: 2, preview: { type: "image", source: "slide-picture", image: { width: 160, height: 120 } } });
    expect((await deckThumbnail(root, "titled.pptx")).preview).toEqual({ type: "title", title: "Quarterly & review" });
    expect((await deckThumbnail(root, "blank.pptx")).preview).toEqual({ type: "title", title: "" });
    expect((await deckThumbnail(workspaceWithFixtures("deck.pptx"), "deck.pptx")).preview).toEqual({ type: "title", title: "Slide 1" });
  });

  it("answer slide 1 only and are cached by revision", async () => {
    const root = workspace({ "deck.pptx": await deckPptx([{ title: "Old", body: "x" }]) });
    await expect(renderThumbnail({ root, path: "deck.pptx" }, { index: 1, width: 160 })).rejects.toThrow(/out of range|1/i);
    expect((await deckThumbnail(root, "deck.pptx")).preview).toEqual({ type: "title", title: "Old" });
    expect(thumbnailCacheKeys().some((key) => key.includes("deck.pptx"))).toBe(true);
    writeFileSync(join(root, "deck.pptx"), await deckPptx([{ title: "New", body: "x" }]));
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "deck.pptx"), later, later);
    expect((await deckThumbnail(root, "deck.pptx")).preview).toEqual({ type: "title", title: "New" });
  });

  it("reach the client as a picture or a title, with the slide count", async () => {
    const root = workspace({ "titled.pptx": await deckPptx([{ title: "Plan", body: "x" }, { title: "b", body: "c" }]) });
    expect(thumbnailAnswer(await renderThumbnail({ root, path: "titled.pptx" }, { index: 0, width: 160 })).thumbnail).toEqual({ type: "title", title: "Plan", count: 2 });
  });
});
