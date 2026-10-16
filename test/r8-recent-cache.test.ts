import { opendir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRecent } from "../server/documents";
import { workspace } from "./helpers";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const rootScans = (root: string) => vi.mocked(opendir).mock.calls.filter(([path]) => path === root).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(opendir).mockClear();
});
afterEach(() => vi.useRealTimers());

describe("R8: docs.recent shares and reuses workspace scans", () => {
  it("runs one scan for concurrent callers and reuses it for 4 s", async () => {
    const root = workspace({ "a.pdf": "%PDF-1.4" });
    const [first, second] = await Promise.all([listRecent(root, {}), listRecent(root, { limit: 1 })]);
    expect(first.entries.map((entry) => entry.path)).toEqual(["a.pdf"]);
    expect(second.entries.map((entry) => entry.path)).toEqual(["a.pdf"]);
    expect(rootScans(root)).toBe(1);

    vi.setSystemTime(Date.now() + 3_900);
    await listRecent(root, {});
    expect(rootScans(root)).toBe(1);

    vi.setSystemTime(Date.now() + 200);
    await listRecent(root, {});
    expect(rootScans(root)).toBe(2);
  });

  it("reuses a slow scan for ten times its duration", async () => {
    const root = workspace({ "a.pdf": "%PDF-1.4" });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      if (path === root) vi.setSystemTime(Date.now() + 1_000);
      return actual.opendir(path, options);
    });
    await listRecent(root, {});
    vi.setSystemTime(Date.now() + 9_900);
    await listRecent(root, {});
    expect(rootScans(root)).toBe(1);

    vi.setSystemTime(Date.now() + 200);
    await listRecent(root, {});
    expect(rootScans(root)).toBe(2);
  });

  it("keeps workspaces apart", async () => {
    const one = workspace({ "one.pdf": "%PDF-1.4" });
    const two = workspace({ "two.docx": "placeholder" });
    expect((await listRecent(one, {})).entries.map((entry) => entry.path)).toEqual(["one.pdf"]);
    expect((await listRecent(two, {})).entries.map((entry) => entry.path)).toEqual(["two.docx"]);
  });
});
