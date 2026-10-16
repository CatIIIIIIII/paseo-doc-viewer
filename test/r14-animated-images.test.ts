import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDocument, readMediaChunk, renderPage } from "../server/documents";
import { errorCode } from "../shared/errors";
import { ANIMATION_MAX_BYTES } from "../shared/limits";
import { gif } from "./fixtures/generators.ts";
import { FIXTURES, decodePng, workspace, workspaceWithFixtures } from "./helpers";

const palette = [[255, 0, 0], [0, 0, 255]];
const red = Array.from({ length: 30 * 20 }, () => 0);
const blue = Array.from({ length: 30 * 20 }, () => 1);
const failure = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error);

async function original(root: string, path: string) {
  const parts: Buffer[] = [];
  let offset: number | null = 0;
  let mimeType = "";
  while (offset !== null) {
    const chunk = await readMediaChunk({ root, path }, { offset, length: 64 });
    mimeType = chunk.mimeType;
    parts.push(Buffer.from(chunk.data, "base64"));
    offset = chunk.nextOffset;
  }
  return { mimeType, bytes: Buffer.concat(parts) };
}

describe("R14: animated GIF and WebP keep their original bytes for the client", () => {
  it("marks an animated GIF and serves its original bytes, while doc.page stays the first frame", async () => {
    const bytes = gif(30, 20, palette, [red, blue], { delayCs: 50 });
    const root = workspace({ "spin.gif": bytes });
    expect(await openDocument({ root, path: "spin.gif" })).toMatchObject({
      kind: "image-raster",
      width: 30,
      height: 20,
      animation: { mimeType: "image/gif", size: bytes.length },
    });
    const page = await renderPage({ root, path: "spin.gif" }, { index: 0 });
    if (page.kind !== "image-raster") throw new Error("expected image");
    expect([...decodePng(page.image.data).data.subarray(0, 3)]).toEqual([255, 0, 0]);
    const served = await original(root, "spin.gif");
    expect(served.mimeType).toBe("image/gif");
    expect(served.bytes.equals(bytes)).toBe(true);
  });

  it("marks an animated WebP with its own mime type", async () => {
    const root = workspaceWithFixtures("animated.webp");
    const opened = await openDocument({ root, path: "animated.webp" });
    expect(opened).toMatchObject({ kind: "image-decoded", animation: { mimeType: "image/webp" } });
    const served = await original(root, "animated.webp");
    expect(served.mimeType).toBe("image/webp");
    expect(served.bytes.equals(readFileSync(join(FIXTURES, "animated.webp")))).toBe(true);
  });

  it("does not mark still images and refuses their original bytes", async () => {
    const root = workspace({
      "still.gif": gif(30, 20, palette, [red]),
      "photo.png": readFileSync(join(FIXTURES, "photo.png")),
      "photo-lossy.webp": readFileSync(join(FIXTURES, "photo-lossy.webp")),
    });
    for (const path of ["still.gif", "photo.png", "photo-lossy.webp"]) {
      const opened = await openDocument({ root, path });
      expect(opened).not.toHaveProperty("animation");
      expect(errorCode(await failure(() => readMediaChunk({ root, path }, { offset: 0, length: 64 })))).toBe("invalid_request");
    }
  });

  it("keeps only the first frame above the animation size cap", async () => {
    const small = gif(30, 20, palette, [red, blue]);
    const bytes = Buffer.concat([small, Buffer.alloc(ANIMATION_MAX_BYTES + 1 - small.length)]);
    const root = workspace({ "big.gif": bytes });
    const opened = await openDocument({ root, path: "big.gif" });
    expect(opened).toMatchObject({ kind: "image-raster", width: 30, height: 20 });
    expect(opened).not.toHaveProperty("animation");
    expect(errorCode(await failure(() => readMediaChunk({ root, path: "big.gif" }, { offset: 0, length: 64 })))).toBe("invalid_request");
  });

  it("treats a GIF cut off after its first frame as a still image", async () => {
    const bytes = gif(30, 20, palette, [red, blue]);
    const root = workspace({ "cut.gif": bytes.subarray(0, bytes.length - 20) });
    expect(await openDocument({ root, path: "cut.gif" })).not.toHaveProperty("animation");
  });
});
