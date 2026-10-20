import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcInput } from "@getpaseo/plugin";
import { ERROR_MESSAGES, isError } from "../shared/errors";
import type { docThumbnailRpc } from "../shared/rpc";
import type { TurnDocsFile } from "../shared/turn-docs";

// Load: a timeline of turn cards asks for thumbnails while a page map opens, through the client's
// real loaders and queue and the daemon's real slots and thumbnail cache. Decoding is a timer that
// ignores its abort signal, like a large image decode.

type DocThumbnailInput = RpcInput<typeof docThumbnailRpc>;

const image = { mimeType: "image/jpeg" as const, width: 80, height: 60, data: "x" };

async function simulate({ cards, perCard, decodeMs }: { cards: number; perCard: number; decodeMs: number }) {
  vi.useFakeTimers();
  vi.resetModules();
  const { thumbnailCached } = await import("../server/thumbnails");
  const { cardThumbnailIndices, createCardThumbnails } = await import("../client/card-thumbnails");
  const { createThumbnailLoader, thumbnailAnswer, thumbnailCache } = await import("../client/thumbnails");
  let decodes = 0;
  let busy = 0;
  const serve = (input: DocThumbnailInput, ms: number) => Promise.resolve().then(() =>
    thumbnailCached({ path: input.path, revision: "r", passwordKey: "" }, input, async () => {
      if (input.keepOpen === false) decodes++;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { kind: "pdf" as const, revision: "r", index: input.index, pageCount: 6, image };
    }));
  const rpc = (_contract: unknown, input: DocThumbnailInput) => serve(input, decodeMs).catch((error: unknown) => {
    if (isError(error, ERROR_MESSAGES.busy())) busy++;
    throw error;
  });
  const client = { rpc } as Parameters<typeof createCardThumbnails>[0];
  const files = (card: number): TurnDocsFile[] => Array.from({ length: perCard }, (_, i) => ({
    path: `card${card}/file${i}.pdf`, kind: "pdf", size: 1_000_000, revision: "r", status: "new",
  }));
  const loaders = Array.from({ length: cards }, (_, card) => {
    const loader = createCardThumbnails(client, { workspaceId: "w", files: files(card) });
    loader.want(cardThumbnailIndices(files(card)));
    return loader;
  });
  await vi.advanceTimersByTimeAsync(2_000);
  const pageMap = createThumbnailLoader({
    identify: (index) => ({ key: `open.pdf\0${index}`, revision: "r" }),
    cache: thumbnailCache,
    fetch: (index) => serve({ workspaceId: "w", path: "open.pdf", index, width: 160 }, 200).then(thumbnailAnswer),
  });
  pageMap.want([0, 1, 2, 3, 4, 5]);
  await vi.advanceTimersByTimeAsync(5_000);
  const pageMapSoon = [0, 1, 2, 3, 4, 5].map((index) => pageMap.state(index)?.status ?? "missing");
  await vi.advanceTimersByTimeAsync(cards * perCard * decodeMs * 3 + 120_000);
  const statuses = loaders.flatMap((loader) => Array.from({ length: perCard }, (_, i) => loader.state(i)?.status ?? "missing"));
  return {
    failed: statuses.filter((status) => status === "failed").length,
    ready: statuses.filter((status) => status === "ready").length,
    busy,
    pageMap: pageMapSoon,
    decodes,
  };
}

afterEach(() => vi.useRealTimers());

describe("load: turn card thumbnails", () => {
  it("loads every thumbnail of 5 cards of 12 large photos, decoding each once, and the page map opened meanwhile within 5 s", async () => {
    const result = await simulate({ cards: 5, perCard: 12, decodeMs: 5_000 });
    expect(result).toEqual({ failed: 0, ready: 60, busy: 0, pageMap: Array(6).fill("ready"), decodes: 60 });
  });

  it("loads every thumbnail of 20 cards of 12 PDFs, and the page map opened meanwhile within 5 s", async () => {
    const result = await simulate({ cards: 20, perCard: 12, decodeMs: 300 });
    expect(result).toEqual({ failed: 0, ready: 240, busy: 0, pageMap: Array(6).fill("ready"), decodes: 240 });
  });

  it("loads every thumbnail of a card of 12 photos that take 12 s each, decoding each once and never told the daemon is busy", async () => {
    const result = await simulate({ cards: 1, perCard: 12, decodeMs: 12_000 });
    expect(result).toMatchObject({ failed: 0, ready: 12, busy: 0, decodes: 12 });
  });
});
