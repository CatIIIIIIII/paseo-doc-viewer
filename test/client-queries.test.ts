import { environmentManager, focusManager, QueryClient, QueryObserver } from "@tanstack/query-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { omittedImagesNote, pageTextNote } from "../client/paging";
import { animationQueryKey, blocksQueryKey, documentQueryOptions, pageQueryKey, recentQueryOptions, rowsQueryKey, textQueryKey } from "../client/queries";

describe("client query keys and polling", () => {
  it("keys every page, block and row request by the document revision", () => {
    expect(pageQueryKey("ws", "a.pdf", "r1", 2, 1024)).toContain("r1");
    expect(pageQueryKey("ws", "a.pdf", "r1", 2, 1024)).not.toEqual(pageQueryKey("ws", "a.pdf", "r2", 2, 1024));
    expect(textQueryKey("ws", "a.pdf", "r1", 2)).toContain("r1");
    expect(textQueryKey("ws", "a.pdf", "r1", 2)).not.toEqual(textQueryKey("ws", "a.pdf", "r2", 2));
    expect(animationQueryKey("ws", "a.gif", "r1")).not.toEqual(animationQueryKey("ws", "a.gif", "r2"));
    expect(blocksQueryKey("ws", "a.docx", "r1")).toContain("r1");
    expect(blocksQueryKey("ws", "a.docx", "r1")).not.toEqual(blocksQueryKey("ws", "a.docx", "r2"));
    expect(rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 0, rowOffset: 0, columnOffset: 0 }, 8)).toContain("r1");
    expect(rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 0, rowOffset: 0, columnOffset: 0 }, 8)).not.toEqual(
      rowsQueryKey("ws", "a.xlsx", "r2", { sheet: 0, rowOffset: 0, columnOffset: 0 }, 8),
    );
  });

  it("separates page keys by index and render width, and row keys by sheet, offsets and column window", () => {
    const keys = [
      pageQueryKey("ws", "a.pdf", "r1", 0, 1024),
      pageQueryKey("ws", "a.pdf", "r1", 1, 1024),
      pageQueryKey("ws", "a.pdf", "r1", 0, 2048),
      textQueryKey("ws", "a.pdf", "r1", 0),
      textQueryKey("ws", "a.pdf", "r1", 1),
      rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 0, rowOffset: 0, columnOffset: 0 }, 8),
      rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 1, rowOffset: 0, columnOffset: 0 }, 8),
      rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 0, rowOffset: 200, columnOffset: 0 }, 8),
      rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 0, rowOffset: 0, columnOffset: 50 }, 8),
      rowsQueryKey("ws", "a.xlsx", "r1", { sheet: 0, rowOffset: 0, columnOffset: 0 }, 16),
    ];
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(keys.length);
  });

  it("keys the open document by unlock attempt and waits for a path", () => {
    const options = documentQueryOptions("ws", "a.pdf");
    expect(options.queryKey).toEqual(["doc.open", "ws", "a.pdf", 0]);
    expect(documentQueryOptions("ws", "a.pdf", 1).queryKey).not.toEqual(options.queryKey);
    expect(options.enabled).toBe(true);
    expect(documentQueryOptions("", "a.pdf").enabled).toBe(false);
  });

  it("polls the recent documents panel", () => {
    const options = recentQueryOptions("ws", {});
    expect(options.queryKey).toEqual(["docs.recent", "ws", "", null]);
    expect(options.refetchInterval).toBeGreaterThan(0);
    expect(options.refetchInterval).toBeLessThanOrEqual(10_000);
  });

  it("keys the recent list by normalized search and type, and keeps the last list while a new filter loads", () => {
    const options = recentQueryOptions("ws", { query: "  Q4   Report ", group: "pdf" });
    expect(options.queryKey).toEqual(["docs.recent", "ws", "q4 report", "pdf"]);
    expect(options.request).toEqual({ workspaceId: "ws", query: "q4 report", group: "pdf" });
    expect(recentQueryOptions("ws", {}).request).toEqual({ workspaceId: "ws" });
    const previous = { entries: [], truncated: false, counts: { pdf: 0, word: 0, excel: 0, powerpoint: 0, image: 0, video: 0 } };
    expect(options.placeholderData(previous)).toBe(previous);
  });
});

describe("open document polling", () => {
  const clients: QueryClient[] = [];
  const runsOnServer = environmentManager.isServer();
  afterEach(() => {
    for (const client of clients.splice(0)) client.unmount();
    vi.useRealTimers();
    focusManager.setFocused(undefined);
    environmentManager.setIsServer(() => runsOnServer);
  });

  function observe(unlockAttempt: number, open: () => Promise<{ revision: string }>) {
    vi.useFakeTimers();
    environmentManager.setIsServer(() => false);
    const client = new QueryClient();
    client.mount();
    clients.push(client);
    const queryFn = vi.fn(open);
    const observer = new QueryObserver(client, { ...documentQueryOptions("ws", "a.pdf", unlockAttempt), queryFn, retry: false });
    const statuses: string[] = [];
    const unsubscribe = observer.subscribe((result) => statuses.push(result.status));
    return { observer, queryFn, statuses, unsubscribe };
  }

  it("polls an open document so a rewritten file shows its new revision", async () => {
    const revisions = ["r1", "r1", "r2"];
    const { observer, queryFn, unsubscribe } = observe(0, async () => ({ revision: revisions.shift() ?? "r2" }));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(observer.getCurrentResult().data).toEqual({ revision: "r2" });
    unsubscribe();
  });

  it("does not refetch a locked document, so the password prompt is never swapped for a loading state", async () => {
    const { queryFn, statuses, unsubscribe } = observe(0, async () => {
      throw new Error("Request failed: [doc:password_required] PDF is encrypted and needs a password");
    });
    await vi.advanceTimersByTimeAsync(16_000);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(statuses.slice(statuses.indexOf("error"))).not.toContain("pending");
    unsubscribe();
  });

  it("keeps polling after unlock, so a locked file rewritten on disk shows its new revision", async () => {
    const revisions = ["r1", "r2"];
    const { observer, unsubscribe } = observe(1, async () => ({ revision: revisions.shift() ?? "r2" }));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(observer.getCurrentResult().data).toEqual({ revision: "r2" });
    unsubscribe();
  });
});

describe("omitted slide images", () => {
  it("says nothing when no image was left out", () => {
    expect(omittedImagesNote(0)).toBeNull();
  });

  it("counts left-out images without guessing why", () => {
    expect(omittedImagesNote(1)).toBe("1 image is not shown");
    expect(omittedImagesNote(3)).toBe("3 images are not shown");
  });

  it("lists distinct reasons when the server gives them", () => {
    expect(omittedImagesNote(3, ["too large to preview", "unsupported image format", "too large to preview"])).toBe(
      "3 images are not shown: too large to preview, unsupported image format",
    );
  });
});

describe("page text notes", () => {
  it("says nothing for a page with complete text", () => {
    expect(pageTextNote({ text: "Invoice", truncated: false })).toBeNull();
  });

  it("explains an empty text layer and a cut", () => {
    expect(pageTextNote({ text: "  \n", truncated: false })).toBe("This page has no selectable text. It may be a scan or outlined text.");
    expect(pageTextNote({ text: "x", truncated: true })).toBe("Text is cut short: this page has more text than the viewer shows.");
  });
});
