import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderPdfPage } from "../server/pdf";
import { textPdf } from "./fixtures/generators.ts";
import { nestedFormPdf } from "./fixtures/hostile";
import { workspace } from "./helpers";

// Audit (post 0.4.0): PDFium renders synchronously inside the plugin's only event loop, so heavy()'s
// 20 s deadline cannot preempt it and every other RPC waits. A 3.5 KB PDF with Form XObjects
// nested 10 deep (4 draws per level) makes the WASM module abort; pdf.ts keeps using the aborted
// library, so every PDF in every workspace fails ("Aborted" or "PDF is damaged") until the
// 60 s idle recycle, which never comes while the user keeps retrying.

const fit = { maxWidth: 800, maxBytes: 6_000_000 };

function file(root: string, name: string, revision = "1") {
  return { path: join(root, name), revision, size: 4096, passwordKey: "" };
}

describe("audit: PDFium isolation", () => {
  it.fails("keeps the event loop responsive while rendering a 3 KB nested-form PDF (currently ~1.3 s blocked)", async () => {
    const root = workspace({ "nested.pdf": nestedFormPdf(9) });
    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last);
      last = now;
    }, 10);
    try {
      await renderPdfPage(file(root, "nested.pdf"), 0, fit);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      clearInterval(probe);
    }
    expect(maxLag).toBeLessThan(500);
  }, 60_000);

  it.fails("renders an ordinary PDF after another PDF aborted the WASM module (currently fails until idle recycle)", async () => {
    const root = workspace({ "bomb.pdf": nestedFormPdf(10), "ok.pdf": await textPdf(["hello"]) });
    await expect(renderPdfPage(file(root, "bomb.pdf"), 0, fit)).rejects.toThrow(/Aborted/);
    const rendered = await renderPdfPage(file(root, "ok.pdf", "after"), 0, fit);
    expect(rendered.image.width).toBe(800);
  }, 60_000);
});
