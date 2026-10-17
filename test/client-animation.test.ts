import { describe, expect, it } from "vitest";
import { animationFormat, loadAnimation } from "../client/animation";
import { encodeBase64 } from "../client/media";
import type { MediaChunkOutput } from "../shared/rpc";

function server(bytes: Uint8Array, { chunk = 7, revision = "r1", mimeType = "image/gif" } = {}) {
  return async ({ offset, length }: { offset: number; length: number }): Promise<MediaChunkOutput> => {
    const end = Math.min(bytes.length, offset + Math.min(length, chunk));
    return {
      kind: "image-raster",
      revision,
      mimeType,
      offset,
      size: bytes.length,
      data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
      nextOffset: end < bytes.length ? end : null,
    };
  };
}

describe("animated image playback format", () => {
  it.each([
    ["web", "image/gif", "image/gif"],
    ["web", "image/webp", "image/webp"],
    ["ios", "image/gif", "image/gif"],
    ["ios", "image/webp", "image/gif"],
    ["android", "image/gif", "image/gif"],
    ["android", "image/webp", "image/gif"],
    ["windows", "image/gif", null],
    ["macos", "image/webp", null],
  ] as const)("%s plays %s as %s", (os, mimeType, expected) => {
    expect(animationFormat(os, mimeType)).toBe(expected);
  });
});

describe("animated image source", () => {
  it("encodes base64 like Buffer across part boundaries and padding lengths", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 100, 70_000]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) % 256);
      const parts = [bytes.subarray(0, Math.floor(length / 3)), bytes.subarray(Math.floor(length / 3), length - 1), bytes.subarray(length - 1)];
      expect(encodeBase64(length === 0 ? [] : parts)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("assembles the chunks into a data URI with the served mime type", async () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, index) => index);
    const uri = await loadAnimation(server(bytes, { mimeType: "image/webp" }), "r1");
    expect(uri).toBe(`data:image/webp;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it("fails when the served file is a different revision than the open document", async () => {
    await expect(loadAnimation(server(new Uint8Array(10), { revision: "r2" }), "r1")).rejects.toThrow(/changed/);
  });

  it("cancels between chunks without building an animation URI", async () => {
    const signal = { aborted: false };
    let calls = 0;
    const source = server(new Uint8Array(100));
    await expect(loadAnimation(async (range) => {
      calls++;
      return source(range);
    }, "r1", { signal, onProgress: () => { signal.aborted = true; } })).rejects.toThrow(/cancelled/);
    expect(calls).toBe(1);
  });
});
