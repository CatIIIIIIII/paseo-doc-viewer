import { describe, expect, it } from "vitest";
import { decodeBase64, loadMedia, NATIVE_AUDIO_MAX_BYTES, playAudioFully } from "../client/media";
import type { MediaChunkOutput } from "../shared/rpc";

function audioServer(bytes: Uint8Array, options: { chunk?: number } = {}) {
  const calls: { offset: number; length: number }[] = [];
  const fetchChunk = async ({ offset, length }: { offset: number; length: number }): Promise<MediaChunkOutput> => {
    calls.push({ offset, length });
    const end = Math.min(bytes.length, offset + Math.min(length, options.chunk ?? length));
    return {
      kind: "audio",
      revision: "r1",
      mimeType: "audio/mpeg",
      offset,
      size: bytes.length,
      data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
      nextOffset: end < bytes.length ? end : null,
    };
  };
  return { fetchChunk, calls };
}

describe("native audio playback", () => {
  it("streams the file and hands the host player one base64 document with its mime type", async () => {
    const bytes = Uint8Array.from({ length: 7000 }, (_, index) => (index * 13) % 256);
    const played: { base64: string; mimeType: string }[] = [];
    const progress: number[] = [];
    const media = await playAudioFully(audioServer(bytes, { chunk: 2500 }).fetchChunk, async (source) => {
      played.push(source);
    }, { onProgress: ({ loaded }) => progress.push(loaded) });
    expect(played).toHaveLength(1);
    expect(played[0]!.mimeType).toBe("audio/mpeg");
    expect(Buffer.from(decodeBase64(played[0]!.base64)).equals(Buffer.from(bytes))).toBe(true);
    expect(media.size).toBe(7000);
    expect(progress).toEqual([2500, 5000, 7000]);
  });

  it("does not call the player when loading fails", async () => {
    const bytes = Uint8Array.from({ length: 100 }, (_, index) => index);
    const played: unknown[] = [];
    const { fetchChunk } = audioServer(bytes, { chunk: 40 });
    let calls = 0;
    const flaky = async (request: { offset: number; length: number }): Promise<MediaChunkOutput> => {
      calls++;
      if (calls === 2) throw new Error("daemon restarted");
      return fetchChunk(request);
    };
    await expect(playAudioFully(flaky, async (source) => { played.push(source); })).rejects.toThrow(/daemon restarted/);
    expect(played).toHaveLength(0);
  });

  it("exposes a native cap below the desktop streaming limit", () => {
    expect(NATIVE_AUDIO_MAX_BYTES).toBeGreaterThan(0);
    expect(NATIVE_AUDIO_MAX_BYTES).toBeLessThan(256 * 1024 * 1024);
  });

  it("reuses loadMedia's guarantees unchanged", async () => {
    const media = await loadMedia(audioServer(new Uint8Array(0)).fetchChunk);
    expect(media.size).toBe(0);
  });
});
