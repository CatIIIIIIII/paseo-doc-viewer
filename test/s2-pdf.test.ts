import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openDocument, renderPage } from "../server/documents";
import { MAX_RENDER_EDGE_PX } from "../shared/limits";
import { decodePng, inkRatio, workspaceWithFixtures } from "./helpers";

vi.mock("node:child_process", () => {
  const refuse = () => {
    throw new Error("S2 forbids external processes");
  };
  return { spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

const originalPath = process.env.PATH;
beforeAll(() => {
  process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
});
afterAll(() => {
  process.env.PATH = originalPath;
});

describe("S2: PDF renders with no system binaries", () => {
  it("S2: a PDF opens and page 1 renders to a PNG with an empty PATH and no child processes", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    const opened = await openDocument({ root, path: "statement.pdf" });
    expect(opened).toMatchObject({ kind: "pdf", pageCount: 3 });

    const page = await renderPage({ root, path: "statement.pdf" }, { index: 0 });
    if (page.kind !== "pdf") throw new Error(`expected pdf page, got ${page.kind}`);
    expect(page.image.mimeType).toBe("image/png");
    const png = decodePng(page.image.data);
    expect(png.width).toBe(page.image.width);
    expect(Math.max(png.width, png.height)).toBeLessThanOrEqual(MAX_RENDER_EDGE_PX);
    expect(inkRatio(png)).toBeGreaterThan(0.002);
  }, 30_000);

  it("S2: a page renders at the requested pixel width, not its point size", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    const page = await renderPage({ root, path: "statement.pdf" }, { index: 0, maxWidth: 1280 });
    if (page.kind !== "pdf") throw new Error(`expected pdf page, got ${page.kind}`);
    expect(page.image.width).toBeGreaterThanOrEqual(1279);
    expect(page.image.width).toBeLessThanOrEqual(1280);
    expect(decodePng(page.image.data).width).toBe(page.image.width);
  }, 30_000);

  it("S2: each page index renders its own page", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    const first = await renderPage({ root, path: "statement.pdf" }, { index: 0 });
    const last = await renderPage({ root, path: "statement.pdf" }, { index: 2 });
    if (first.kind !== "pdf" || last.kind !== "pdf") throw new Error("expected pdf pages");
    expect(last.index).toBe(2);
    expect(last.image.data).not.toBe(first.image.data);
  }, 30_000);

  it("S2: an encrypted PDF fails with a password error", async () => {
    const root = workspaceWithFixtures("locked.pdf");
    await expect(openDocument({ root, path: "locked.pdf" })).rejects.toThrow(/password|encrypted/i);
  });

  it("S2: a truncated PDF fails with a damaged-file error", async () => {
    const root = workspaceWithFixtures("truncated.pdf");
    await expect(openDocument({ root, path: "truncated.pdf" })).rejects.toThrow(/damaged|corrupt|invalid/i);
  });

  it("S2: a page index past the end fails with an out-of-range error", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    await expect(renderPage({ root, path: "statement.pdf" }, { index: 3 })).rejects.toThrow(/out of range/i);
  });
});
