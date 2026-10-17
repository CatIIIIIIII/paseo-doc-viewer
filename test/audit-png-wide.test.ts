import { describe, expect, it } from "vitest";
import { renderPage } from "../server/documents";
import { errorCode } from "../shared/errors";
import { pngHeaderOnly } from "./fixtures/hostile";
import { workspace } from "./helpers";

// Audit (post 0.4.0): images.ts streams any PNG up to MAX_STREAMED_PIXELS (300M) through
// png.ts decodePngScaled, which allocates width-proportional buffers (Int32Array(width) plus two
// row buffers) before reading any pixel data. A 69-byte PNG claiming 300,000,000 x 1 grew RSS by
// ~1.1 GB and reserved 3.4 GB (RGBA8) or 5.7 GB (RGBA16) of ArrayBuffers in a scratch run before
// failing as "truncated". The area cap does not bound a single row.

describe("audit: very wide PNG headers", () => {
  it.fails("rejects a 300M x 1 PNG as too large instead of allocating row buffers (currently 'damaged' after ~1 GB)", async () => {
    const root = workspace({ "strip.png": pngHeaderOnly(300_000_000, 1) });
    let error: unknown;
    try {
      await renderPage({ root, path: "strip.png" }, { index: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(errorCode(error)).toBe("too_large");
  });
});
