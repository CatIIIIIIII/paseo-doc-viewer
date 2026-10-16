import { describe, expect, it } from "vitest";
import { decodeBase64, loadMedia, MEDIA_REQUEST_BYTES } from "../client/media";
import type { MediaChunkOutput } from "../shared/rpc";

function server(bytes: Uint8Array, options: { chunk?: number; revisions?: string[] } = {}) {
  const calls: { offset: number; length: number }[] = [];
  const fetchChunk = async ({ offset, length }: { offset: number; length: number }): Promise<MediaChunkOutput> => {
    calls.push({ offset, length });
    const end = Math.min(bytes.length, offset + Math.min(length, options.chunk ?? length));
    return {
      kind: "video",
      revision: options.revisions?.[calls.length - 1] ?? "r1",
      mimeType: "video/mp4",
      offset,
      size: bytes.length,
      data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
      nextOffset: end < bytes.length ? end : null,
    };
  };
  return { fetchChunk, calls };
}

const join = (parts: Uint8Array[]) => Buffer.concat(parts.map((part) => Buffer.from(part)));

describe("client media chunk assembly", () => {
  it("decodes base64 like Buffer for every padding length", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 255]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
      expect(Buffer.from(decodeBase64(Buffer.from(bytes).toString("base64")))).toEqual(Buffer.from(bytes));
    }
    expect(() => decodeBase64("ab$d")).toThrow(/base64/);
  });

  it("follows nextOffset until the end and reassembles the file byte for byte", async () => {
    const bytes = Uint8Array.from({ length: 10_000 }, (_, index) => index % 251);
    const { fetchChunk, calls } = server(bytes, { chunk: 3000 });
    const progress: number[] = [];
    const media = await loadMedia(fetchChunk, { onProgress: ({ loaded }) => progress.push(loaded) });
    expect(join(media.parts).equals(Buffer.from(bytes))).toBe(true);
    expect(media).toMatchObject({ mimeType: "video/mp4", revision: "r1", size: 10_000 });
    expect(calls.map((call) => call.offset)).toEqual([0, 3000, 6000, 9000]);
    expect(calls.every((call) => call.length === MEDIA_REQUEST_BYTES)).toBe(true);
    expect(progress).toEqual([3000, 6000, 9000, 10_000]);
  });

  it("handles an empty file", async () => {
    const media = await loadMedia(server(new Uint8Array()).fetchChunk);
    expect(media.size).toBe(0);
  });

  it("fails when the file changes mid-stream instead of splicing two revisions", async () => {
    const { fetchChunk } = server(new Uint8Array(100), { chunk: 40, revisions: ["r1", "r2"] });
    await expect(loadMedia(fetchChunk)).rejects.toThrow(/changed while loading/);
  });

  it("fails on a chunk whose length disagrees with nextOffset", async () => {
    const fetchChunk = async (): Promise<MediaChunkOutput> => ({
      kind: "video",
      revision: "r1",
      mimeType: "video/mp4",
      offset: 0,
      size: 10,
      data: Buffer.from([1, 2, 3]).toString("base64"),
      nextOffset: 5,
    });
    await expect(loadMedia(fetchChunk)).rejects.toThrow(/points to 5/);
  });

  it("stops when cancelled", async () => {
    const signal = { aborted: false };
    const { fetchChunk } = server(new Uint8Array(100), { chunk: 10 });
    const loading = loadMedia(
      async (range) => {
        signal.aborted = true;
        return fetchChunk(range);
      },
      { signal },
    );
    await expect(loading).rejects.toThrow(/cancelled/);
  });
});
