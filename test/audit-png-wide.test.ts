import { describe, expect, it } from "vitest";
import { renderPage } from "../server/documents";
import { errorCode } from "../shared/errors";
import { blankGrayPng } from "./fixtures/generators.ts";
import { pngHeaderOnly } from "./fixtures/hostile";
import { workspace } from "./helpers";

// Audit (post 0.4.0): images.ts streams any PNG up to MAX_STREAMED_PIXELS (300M) through
// png.ts decodePngScaled, which allocated width-proportional buffers (Int32Array(width) plus two
// row buffers) before reading any pixel data. A 69-byte PNG claiming 300,000,000 x 1 grew RSS by
// ~1.1 GB and reserved 3.4 GB (RGBA8) or 5.7 GB (RGBA16) of ArrayBuffers in a scratch run before
// failing as "truncated". The area cap did not bound a single row; the row state is now capped.

describe("audit: very wide PNG headers", () => {
  it("rejects a 300M x 1 PNG as too large instead of allocating row buffers", async () => {
    const root = workspace({ "strip.png": pngHeaderOnly(300_000_000, 1) });
    let error: unknown;
    try {
      await renderPage({ root, path: "strip.png" }, { index: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(errorCode(error)).toBe("too_large");
  });

  it("still streams a wide panorama", async () => {
    const root = workspace({ "wide.png": blankGrayPng(40_000, 2) });
    const page = await renderPage({ root, path: "wide.png" }, { index: 0, maxWidth: 800 });
    expect(page).toMatchObject({ kind: "image-raster" });
  });
});
