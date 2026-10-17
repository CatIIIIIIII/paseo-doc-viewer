import { describe, expect, it, vi } from "vitest";
import { hasDocuments } from "../server/recent";
import { workspace } from "./helpers";

const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: (...args: Parameters<typeof actual.opendir>) => { opened.count++; return actual.opendir(...args); } };
});

describe("docs.any", () => {
  it("stops at the first supported file instead of scanning the workspace", async () => {
    const files: Record<string, string> = { "report.pdf": "%PDF-" };
    for (let i = 0; i < 40; i++) files[`src/module-${i}/index.ts`] = "";
    const root = workspace(files);
    opened.count = 0;
    expect(await hasDocuments(root)).toBe(true);
    expect(opened.count).toBe(1);
  });

  it("follows the Documents scan rules", async () => {
    expect(await hasDocuments(workspace({ "notes.txt": "", ".cache/hidden.pdf": "", "node_modules/pkg/doc.pdf": "", "~$lock.docx": "" }))).toBe(false);
    expect(await hasDocuments(workspace({ "a/b/c/song.mp3": "" }))).toBe(true);
    expect(await hasDocuments(workspace())).toBe(false);
  });
});
