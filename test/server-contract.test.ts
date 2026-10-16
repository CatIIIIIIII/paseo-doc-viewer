import { describe, expect, it } from "vitest";
import { openDocument, readMediaChunk, renderPage } from "../server/documents";
import { blankGrayPng, fakeMp4 } from "./fixtures/generators.ts";
import { workspace, workspaceWithFixtures } from "./helpers";

describe("server contract relied on by the client", () => {
  it("doc.open answers an unchanged file from the per-revision cache", async () => {
    const root = workspaceWithFixtures("invoices.xlsx");
    const first = await openDocument({ root, path: "invoices.xlsx" });
    const second = await openDocument({ root, path: "invoices.xlsx" });
    expect(second).toBe(first);
  });

  it("media.chunk echoes the offset, advances by the bytes returned, and keeps a stable revision", async () => {
    const root = workspace({ "clip.mp4": fakeMp4(10_000) });
    const first = await readMediaChunk({ root, path: "clip.mp4" }, { offset: 1_000, length: 2_500 });
    const second = await readMediaChunk({ root, path: "clip.mp4" }, { offset: 1_000, length: 2_500 });
    expect(first.offset).toBe(1_000);
    expect(first.nextOffset).toBe(1_000 + Buffer.from(first.data, "base64").length);
    expect(second.revision).toBe(first.revision);
  });

  it("errors carry the keywords the client maps to readable states", async () => {
    const root = workspaceWithFixtures("locked.pdf", "legacy-format.docx");
    await expect(openDocument({ root, path: "locked.pdf" })).rejects.toThrow(/password/);
    await expect(openDocument({ root, path: "locked.pdf" })).rejects.toThrow(/encrypted/);
    await expect(openDocument({ root, path: "legacy-format.docx" })).rejects.toThrow(/legacy/i);
    await expect(openDocument({ root, path: "../elsewhere.pdf" })).rejects.toThrow(/outside the workspace/);
    await expect(openDocument({ root, path: "missing.pdf" })).rejects.toThrow(/not found/);

    const header = blankGrayPng(1, 1);
    header.writeUInt32BE(20_000, 16);
    header.writeUInt32BE(20_000, 20);
    const huge = workspace({ "huge.png": header });
    await expect(renderPage({ root: huge, path: "huge.png" }, { index: 0 })).rejects.toThrow(/too large/);
  });
});
