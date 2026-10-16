import type { PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { describeError, relativeTime } from "../client/format";
import { ERROR_MESSAGES } from "../shared/errors";
import { DOCUMENTS_PANEL_ID, newestFirst, openByPath, openMostRecent } from "../client/recent";

function commandContext(entries: { path: string; mtimeMs: number }[]) {
  return {
    rpc: vi.fn(async () => ({
      entries: entries.map((entry) => ({ ...entry, kind: "pdf" as const, size: 1 })),
      truncated: false,
    })) as unknown as PluginWorkspaceCommandContext["rpc"],
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
    [ERROR_MESSAGES.pdfEncrypted(), "This PDF is password protected"],
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
