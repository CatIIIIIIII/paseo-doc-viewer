import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pluginRoot from "@getpaseo/plugin";
import * as pluginServer from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import * as zod from "zod";
import { renderPdfPage } from "../server/pdf";
import { textPdf } from "./fixtures/generators.ts";
import { nestedFormPdf } from "./fixtures/hostile";
import { decodePng, workspace } from "./helpers";
import { compileLikePaseo, evaluateBundle } from "./paseo-compile";

// Audit (post 0.4.0): PDFium rendered synchronously inside the plugin's only event loop, so heavy()'s
// 20 s deadline could not preempt it and every other RPC waited. A 3.5 KB PDF with Form XObjects
// nested 10 deep (4 draws per level) makes the WASM module abort, and the aborted library kept
// failing every PDF until the idle recycle. PDFium now runs in a worker thread that is replaced
// after an abort.

const fit = { maxWidth: 800, maxBytes: 6_000_000 };

function file(root: string, name: string, revision = "1") {
  return { path: join(root, name), revision, size: 4096, passwordKey: "" };
}

describe("audit: PDFium isolation", () => {
  it("keeps the event loop responsive while rendering a 3 KB nested-form PDF", async () => {
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

  it("renders an ordinary PDF right after another PDF aborted the WASM module", async () => {
    const root = workspace({ "bomb.pdf": nestedFormPdf(10), "ok.pdf": await textPdf(["hello"]) });
    await expect(renderPdfPage(file(root, "bomb.pdf"), 0, fit)).rejects.toThrow(/could not be rendered/);
    const rendered = await renderPdfPage(file(root, "ok.pdf", "after"), 0, fit);
    expect(rendered.image.width).toBe(800);
  }, 60_000);

  it("runs the PDFium worker from a server bundle compiled and evaluated like Paseo", async () => {
    const bundle = await compileLikePaseo("server");
    const outside = createRequire(join(tmpdir(), "outside-plugin.cjs"));
    const host: Record<string, unknown> = { "@getpaseo/plugin": pluginRoot, "@getpaseo/plugin/server": pluginServer, zod };
    const contribute = evaluateBundle<(server: unknown) => () => void>(bundle, (name) => host[name] ?? outside(name));
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    contribute({ handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler) });
    const root = workspace({ "bomb.pdf": nestedFormPdf(10), "ok.pdf": await textPdf(["hello"]) });
    const paseo = {
      workspaces: {
        list: async () => ({
          entries: [{ id: "ws-1", workspaceDirectory: root, projectRootPath: root }],
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        }),
      },
    };
    const page = (path: string) => handlers.get("doc.page")!({ workspaceId: "ws-1", path, index: 0, maxWidth: 400 }, { paseo });
    await expect(page("bomb.pdf")).rejects.toThrow(/could not be rendered/);
    const rendered = (await page("ok.pdf")) as { image: { data: string } };
    expect(decodePng(rendered.image.data).width).toBe(400);
  }, 60_000);
});
