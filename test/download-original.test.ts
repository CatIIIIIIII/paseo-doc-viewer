import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileChunk, fileInfo } from "../server/files";
import { workspace } from "./helpers";

describe("original file download", () => {
  it("downloads unsupported binary files without preview parsing, byte for byte", async () => {
    const bytes = Buffer.from(Array.from({ length: 1100 }, (_, i) => i % 256));
    const root = workspace({ "file.unknown": bytes });
    const info = await fileInfo(root, "file.unknown");
    expect(info.name).toBe("file.unknown");
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = await fileChunk(root, "file.unknown", info.revision, offset, 127);
      parts.push(Buffer.from(chunk.data, "base64")); offset = chunk.nextOffset;
    }
    expect(Buffer.concat(parts)).toEqual(bytes);
  });
  it("supports empty files and rejects rewritten files and invalid ranges", async () => {
    const root = workspace({ "empty": "" });
    const info = await fileInfo(root, "empty");
    expect(await fileChunk(root, "empty", info.revision, 0, 1024)).toMatchObject({ data: "", nextOffset: null });
    await expect(fileChunk(root, "empty", info.revision, -1, 10)).rejects.toThrow(/range/);
    writeFileSync(join(root, "empty"), "changed");
    await expect(fileChunk(root, "empty", info.revision, 0, 10)).rejects.toThrow(/changed/);
  });
  it("rejects directories, traversal and symlinks outside the workspace", async () => {
    const root = workspace(); const outside = workspace({ "secret": "secret" });
    await expect(fileInfo(root, ".")).rejects.toThrow(/regular file/);
    await expect(fileInfo(root, "../secret")).rejects.toThrow(/outside/);
    symlinkSync(join(outside, "secret"), join(root, "alias"));
    await expect(fileInfo(root, "alias")).rejects.toThrow(/outside/);
  });
  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const root = workspace();
    execFileSync("mkfifo", [join(root, "pipe.pdf")]);
    await expect(fileInfo(root, "pipe.pdf")).rejects.toThrow(/regular file/);
  }, 2000);
});
