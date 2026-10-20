import { describe, expect, it, vi } from "vitest";
import { createOpenedMarks, watchOpenedRevisions } from "../client/opened-marks";
import { ERROR_MESSAGES } from "../shared/errors";
import type { TurnDocsFile } from "../shared/turn-docs";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function rpcHarness() {
  const calls: { input: { paths?: string[]; path?: string }; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const client = {
    rpc: (_contract: unknown, input: { paths?: string[]; path?: string }) => new Promise((resolve, reject) => calls.push({ input, resolve, reject })),
  } as never;
  return { client, calls };
}

describe("turn card Opened marks", () => {
  it("read again when a listed file is opened in the same workspace, and only then", async () => {
    const { client, calls } = rpcHarness();
    const marks = createOpenedMarks();
    const seen: unknown[] = [];
    watchOpenedRevisions(client, "w", ["a.pdf", "b.pdf"], (opened) => seen.push(opened), marks);
    calls[0]!.resolve({ opened: {} });
    await flush();
    marks.notify({ workspaceId: "w", path: "c.pdf" });
    marks.notify({ workspaceId: "other", path: "a.pdf" });
    marks.notify({ workspaceId: "w", path: "a.pdf" });
    calls[1]!.resolve({ opened: { "a.pdf": "1-2-3" } });
    await flush();
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([{}, { "a.pdf": "1-2-3" }]);
  });

  it("pass on only the latest read when answers arrive out of order", async () => {
    const { client, calls } = rpcHarness();
    const marks = createOpenedMarks();
    const seen: unknown[] = [];
    watchOpenedRevisions(client, "w", ["a.pdf"], (opened) => seen.push(opened), marks);
    marks.notify({ workspaceId: "w", path: "a.pdf" });
    calls[1]!.resolve({ opened: { "a.pdf": "new" } });
    calls[0]!.resolve({ opened: {} });
    await flush();
    expect(seen).toEqual([{ "a.pdf": "new" }]);
  });

  it("drop an answer that arrives after the card unmounted or listed other files", async () => {
    const { client, calls } = rpcHarness();
    const marks = createOpenedMarks();
    const seen: unknown[] = [];
    const stopFirst = watchOpenedRevisions(client, "w", ["a.pdf"], (opened) => seen.push(["first", opened]), marks);
    stopFirst();
    const stopSecond = watchOpenedRevisions(client, "w", ["b.pdf"], (opened) => seen.push(["second", opened]), marks);
    calls[0]!.resolve({ opened: { "a.pdf": "late" } });
    calls[1]!.resolve({ opened: { "b.pdf": "1-2-3" } });
    await flush();
    stopSecond();
    marks.notify({ workspaceId: "w", path: "b.pdf" });
    expect(calls).toHaveLength(2);
    expect(seen).toEqual([["second", { "b.pdf": "1-2-3" }]]);
  });

  it("keep what they showed when a read fails, and read again on the next open", async () => {
    const { client, calls } = rpcHarness();
    const marks = createOpenedMarks();
    const seen: unknown[] = [];
    watchOpenedRevisions(client, "w", ["a.pdf"], (opened) => seen.push(opened), marks);
    calls[0]!.reject(new Error(ERROR_MESSAGES.busy()));
    await flush();
    marks.notify({ workspaceId: "w", path: "a.pdf" });
    calls[1]!.resolve({ opened: { "a.pdf": "1-2-3" } });
    await flush();
    expect(seen).toEqual([{ "a.pdf": "1-2-3" }]);
  });

  it("ask nothing for a card without files", () => {
    const { client, calls } = rpcHarness();
    watchOpenedRevisions(client, "w", [], () => {}, createOpenedMarks())();
    expect(calls).toEqual([]);
  });
});

describe("turn card thumbnails", () => {
  const files = (prefix: string, count: number): TurnDocsFile[] => Array.from({ length: count }, (_, i) => ({
    path: `${prefix}${i}.pdf`, kind: "pdf", size: 1_000, revision: "r", status: "new",
  }));
  const answer = (path: string) => ({ kind: "pdf", revision: "r", index: 0, pageCount: 1, image: { mimeType: "image/png", width: 8, height: 10, data: path } });

  async function fresh(client: never) {
    vi.resetModules();
    const { cardThumbnailIndices, createCardThumbnails } = await import("../client/card-thumbnails");
    return (list: TurnDocsFile[]) => {
      const card = createCardThumbnails(client, { workspaceId: "w", files: list });
      card.want(cardThumbnailIndices(list));
      return card;
    };
  }

  it("on new files, stop asking for the old ones and keep their answers in the cache only", async () => {
    const { client, calls } = rpcHarness();
    const mount = await fresh(client);
    const before = mount(files("old", 6));
    let notified = 0;
    before.subscribe(() => notified++);
    await flush();
    before.close();
    mount(files("new", 1));
    for (const call of calls.splice(0)) call.resolve(answer(call.input.path!));
    await flush();
    expect(notified).toBe(0);
    expect(calls.map((call) => call.input.path)).toEqual(["new0.pdf"]);
    expect(mount(files("old", 1)).state(0)?.status).toBe("ready");
  });

  it("notify nobody when an answer arrives after the card unmounted", async () => {
    const { client, calls } = rpcHarness();
    const mount = await fresh(client);
    const listener = vi.fn();
    const unmountWhileAsking = async (prefix: string) => {
      const card = mount(files(prefix, 2));
      card.subscribe(listener);
      await flush();
      card.close();
      return calls.at(-1)!;
    };
    (await unmountWhileAsking("answered")).resolve(answer("answered0.pdf"));
    await flush();
    (await unmountWhileAsking("busy")).reject(new Error(ERROR_MESSAGES.busy()));
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(calls.map((call) => call.input.path)).toEqual(["answered0.pdf", "busy0.pdf"]);
  });

  it("keep the icon of a file whose thumbnail failed, without asking again", async () => {
    const { client, calls } = rpcHarness();
    const mount = await fresh(client);
    const card = mount(files("bad", 1));
    await flush();
    calls[0]!.reject(new Error(ERROR_MESSAGES.pdfPasswordRequired()));
    await flush();
    expect(card.state(0)).toMatchObject({ status: "failed" });
    expect(calls).toHaveLength(1);
    card.close();
  });
});
