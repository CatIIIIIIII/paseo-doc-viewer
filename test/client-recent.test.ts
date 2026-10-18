import type { PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { describeError, relativeTime } from "../client/format";
import { ERROR_MESSAGES } from "../shared/errors";
import { DOCUMENTS_PANEL_ID, openByPath, openMostRecent, type RecentEntry } from "../client/recent";
import { countGroups, type DocumentGroup, KIND_GROUP, newestFirst } from "../shared/browse";

type Listed = { path: string; mtimeMs: number; kind?: RecentEntry["kind"] };

// Mimics docs.recent: newest first, capped at `cap`, with counts over the whole scan.
function commandContext(listed: Listed[], cap = 50) {
  const all = listed.map((entry) => ({ kind: "pdf" as const, ...entry, size: 1 }));
  return {
    rpc: vi.fn(async (_contract: unknown, input: { group?: DocumentGroup; limit?: number }) => {
      const matched = newestFirst(all).filter((entry) => !input.group || KIND_GROUP[entry.kind] === input.group);
      return { entries: matched.slice(0, input.limit ?? cap), truncated: matched.length > cap, counts: countGroups(all) };
    }) as unknown as PluginWorkspaceCommandContext["rpc"],
    openScreen: vi.fn(),
    openPanel: vi.fn(),
    workspace: { id: "ws-1" },
  };
}

describe("client recent documents", () => {
  it("orders newest first regardless of server order", () => {
    const sorted = newestFirst([
      { path: "a.pdf", kind: "pdf", mtimeMs: 1, size: 1 },
      { path: "c.pdf", kind: "pdf", mtimeMs: 3, size: 1 },
      { path: "b.pdf", kind: "pdf", mtimeMs: 3, size: 1 },
    ]);
    expect(sorted.map((entry) => entry.path)).toEqual(["b.pdf", "c.pdf", "a.pdf"]);
  });

  it("opens the newest document even when the server lists it last", async () => {
    const context = commandContext([
      { path: "old.pdf", mtimeMs: 1 },
      { path: "build/main.pdf", mtimeMs: 9 },
    ]);
    await openMostRecent(context);
    expect(context.openScreen).toHaveBeenCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "build/main.pdf" } });
  });

  it("prefers the newest document over a newer screenshot, video or audio file", async () => {
    const context = commandContext([
      { path: "report.pdf", mtimeMs: 5 },
      { path: "shots/login.png", mtimeMs: 9, kind: "image-raster" },
      { path: "results.csv", mtimeMs: 7, kind: "csv" },
    ]);
    await openMostRecent(context);
    expect(context.openScreen).toHaveBeenCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "results.csv" } });
  });

  it("finds a document even when newer screenshots fill the capped list", async () => {
    const shots = Array.from({ length: 3 }, (_, index) => ({ path: `shots/${index}.png`, mtimeMs: 10 + index, kind: "image-raster" as const }));
    const context = commandContext([...shots, { path: "notes.docx", mtimeMs: 2, kind: "docx" }, { path: "old.pdf", mtimeMs: 1 }], 3);
    await openMostRecent(context);
    expect(context.openScreen).toHaveBeenCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "notes.docx" } });
    expect(context.rpc).toHaveBeenCalledTimes(3);
  });

  it("falls back to the newest image when the workspace has no documents", async () => {
    const context = commandContext([{ path: "a.png", mtimeMs: 1, kind: "image-raster" }, { path: "b.mp4", mtimeMs: 2, kind: "video" }]);
    await openMostRecent(context);
    expect(context.openScreen).toHaveBeenCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "b.mp4" } });
    expect(context.rpc).toHaveBeenCalledTimes(1);
  });

  it("opens the Documents panel when the workspace has no documents", async () => {
    const context = commandContext([]);
    await openMostRecent(context);
    expect(context.openScreen).not.toHaveBeenCalled();
    expect(context.openPanel).toHaveBeenCalledWith(DOCUMENTS_PANEL_ID);
  });

  it("/doc opens a given path, or the most recent document without one", async () => {
    const context = commandContext([{ path: "latest.docx", mtimeMs: 5 }]);
    await openByPath({ ...context, args: " ./report/main.pdf " });
    expect(context.openScreen).toHaveBeenLastCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "report/main.pdf" } });
    await openByPath({ ...context, args: "" });
    expect(context.openScreen).toHaveBeenLastCalledWith({ screenId: "document", params: { workspaceId: "ws-1", path: "latest.docx" } });
  });

  it("formats mtimes relative to now", () => {
    const now = Date.UTC(2026, 9, 15, 12);
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("yesterday");
    expect(relativeTime(now + 10_000, now)).toBe("just now");
  });
});

describe("client error states", () => {
  it.each([
    [ERROR_MESSAGES.pdfPasswordRequired(), "This PDF is password protected"],
    [ERROR_MESSAGES.legacyOffice(), "Legacy Office format"],
    [ERROR_MESSAGES.tooLargeForBudget("Page"), "Too large to preview"],
    [ERROR_MESSAGES.outsideWorkspace(), "Outside the workspace"],
    [ERROR_MESSAGES.fileNotFound("a.pdf"), "File not found"],
    [ERROR_MESSAGES.pdfDamaged(), "The file looks damaged"],
  ])("maps %j to a readable title", (message, title) => {
    expect(describeError(new Error(message)).title).toBe(title);
  });

  it("keeps the server message for anything unrecognized", () => {
    expect(describeError(new Error("disk on fire"))).toMatchObject({ title: "Unable to open document", detail: "disk on fire" });
  });
});
