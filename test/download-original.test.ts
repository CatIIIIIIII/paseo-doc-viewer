import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileChunk, fileInfo } from "../server/files";
import { workspace } from "./helpers";

const hooks = vi.hoisted(() => ({ afterOpen: null as (() => void) | null }));
vi.mock("../server/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/paths")>();
  let calls = 0;
  return {
    ...actual,
    resolveInside: async (root: string, path: string) => {
      if (hooks.afterOpen && calls++ % 2 === 1) hooks.afterOpen();
      return actual.resolveInside(root, path);
    },
  };
});

describe("original file download", () => {
  it("downloads a supported file whose preview fails, byte for byte", async () => {
    const bytes = Buffer.from(Array.from({ length: 1100 }, (_, i) => i % 256));
    const root = workspace({ "broken.pdf": bytes });
    const info = await fileInfo(root, "broken.pdf");
    expect(info.name).toBe("broken.pdf");
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = await fileChunk(root, "broken.pdf", info.revision, offset, 127);
      parts.push(Buffer.from(chunk.data, "base64")); offset = chunk.nextOffset;
    }
    expect(Buffer.concat(parts)).toEqual(bytes);
  });
  it("supports empty files and rejects rewritten files and invalid ranges", async () => {
    const root = workspace({ "empty.csv": "" });
    const info = await fileInfo(root, "empty.csv");
    expect(await fileChunk(root, "empty.csv", info.revision, 0, 1024)).toMatchObject({ data: "", nextOffset: null });
    await expect(fileChunk(root, "empty.csv", info.revision, -1, 10)).rejects.toThrow(/range/);
    writeFileSync(join(root, "empty.csv"), "changed");
    await expect(fileChunk(root, "empty.csv", info.revision, 0, 10)).rejects.toThrow(/changed/);
  });
  it("refuses files the viewer does not support and hidden files or folders", async () => {
    const root = workspace({
      ".env": "SECRET=1", "id_rsa": "key", "file.unknown": "x", ".git/config": "[core]",
      ".hidden.pdf": "%PDF-", ".cache/report.pdf": "%PDF-", "reports/.private/q3.xlsx": "x", "link.pdf": "",
    });
    for (const path of [".env", "id_rsa", "file.unknown", ".git/config"]) {
      await expect(fileInfo(root, path), path).rejects.toThrow(/viewer supports/);
      await expect(fileChunk(root, path, "r", 0, 10), path).rejects.toThrow(/viewer supports/);
    }
    for (const path of [".hidden.pdf", ".cache/report.pdf", "reports/.private/q3.xlsx", "reports/../.hidden.pdf"]) {
      await expect(fileInfo(root, path), path).rejects.toThrow(/hidden/i);
    }
    execFileSync("rm", [join(root, "link.pdf")]);
    symlinkSync(join(root, ".cache/report.pdf"), join(root, "link.pdf"));
    await expect(fileInfo(root, "link.pdf")).rejects.toThrow(/hidden/i);
  });
  it("rejects directories, traversal and symlinks outside the workspace", async () => {
    const root = workspace(); const outside = workspace({ "secret.pdf": "secret" });
    mkdirSync(join(root, "folder.pdf"));
    await expect(fileInfo(root, "folder.pdf")).rejects.toThrow(/regular file/);
    await expect(fileInfo(root, "../secret.pdf")).rejects.toThrow(/outside/);
    symlinkSync(join(outside, "secret.pdf"), join(root, "alias.pdf"));
    await expect(fileInfo(root, "alias.pdf")).rejects.toThrow(/outside/);
  });
  it("rejects a file swapped between resolving and opening", async () => {
    const root = workspace({ "report.pdf": "inside", "other.pdf": "replacement" });
    hooks.afterOpen = () => renameSync(join(root, "other.pdf"), join(root, "report.pdf"));
    try {
      await expect(fileInfo(root, "report.pdf")).rejects.toThrow(/changed/);
    } finally {
      hooks.afterOpen = null;
    }
  });
  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const root = workspace();
    execFileSync("mkfifo", [join(root, "pipe.pdf")]);
    await expect(fileInfo(root, "pipe.pdf")).rejects.toThrow(/regular file/);
  }, 2000);
});
