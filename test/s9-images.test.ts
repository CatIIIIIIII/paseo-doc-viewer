import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDocument, renderPage } from "../server/documents";
import { pngToRgba8 } from "./fixtures/generators.ts";
import { FIXTURES, decodePng, workspaceWithFixtures } from "./helpers";

const reference = pngToRgba8(readFileSync(join(FIXTURES, "photo.png")));

function meanAbsoluteError(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

describe("S9: HEIC and TIFF images render", () => {
  for (const name of ["photo.tiff", "photo.heic"]) {
    it(`S9: ${name} opens as a decoded image and renders to PNG matching the source pixels`, async () => {
      const root = workspaceWithFixtures(name);
      expect(await openDocument({ root, path: name })).toMatchObject({
        kind: "image-decoded",
        width: reference.width,
        height: reference.height,
      });
      const page = await renderPage({ root, path: name }, { index: 0 });
      if (page.kind !== "image-decoded") throw new Error(`expected decoded image, got ${page.kind}`);
      expect(page.image.mimeType).toBe("image/png");
      const png = decodePng(page.image.data);
      expect(png).toMatchObject({ width: reference.width, height: reference.height });
      expect(meanAbsoluteError(png.data, reference.data)).toBeLessThan(8);
    }, 30_000);
  }

  it("S9: a PNG keeps the raster path and is not transcoded through the decoder", async () => {
    const root = workspaceWithFixtures("photo.png");
    expect(await openDocument({ root, path: "photo.png" })).toMatchObject({ kind: "image-raster" });
  });
});
