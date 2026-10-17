import type { MediaChunkOutput } from "../shared/rpc";

export const MEDIA_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_PLAYABLE_BYTES = 256 * 1024 * 1024;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index++) LOOKUP[ALPHABET.charCodeAt(index)] = index;
const CODES = Uint8Array.from(ALPHABET, (char) => char.charCodeAt(0));
const PAD = 61;
const STRING_CHUNK = 8192;

export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[\s=]/g, "");
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < clean.length; index++) {
    const code = clean.charCodeAt(index);
    const value = code < 128 ? LOOKUP[code]! : -1;
    if (value < 0) throw new Error("Invalid base64 in media chunk");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[written++] = (buffer >> bits) & 0xff;
    }
  }
  return output.subarray(0, written);
}

export function encodeBase64(parts: readonly Uint8Array[]): string {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(Math.ceil(total / 3) * 4);
  let group = 0;
  let filled = 0;
  let written = 0;
  const flush = () => {
    output[written++] = CODES[group >> 18]!;
    output[written++] = CODES[(group >> 12) & 63]!;
    output[written++] = CODES[(group >> 6) & 63]!;
    output[written++] = CODES[group & 63]!;
  };
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      group = (group << 8) | part[index]!;
      if (++filled === 3) {
        flush();
        group = 0;
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    group <<= 8 * (3 - filled);
    flush();
    output[written - 1] = PAD;
    if (filled === 1) output[written - 2] = PAD;
  }
  const strings: string[] = [];
  for (let index = 0; index < output.length; index += STRING_CHUNK) {
    strings.push(String.fromCharCode(...output.subarray(index, index + STRING_CHUNK)));
  }
  return strings.join("");
}

export interface MediaProgress {
  loaded: number;
  size: number;
}

export interface AssembledMedia {
  mimeType: string;
  revision: string;
  parts: Uint8Array[];
  size: number;
}

export async function loadMedia(
  fetchChunk: (request: { offset: number; length: number }) => Promise<MediaChunkOutput>,
  options: { signal?: { aborted: boolean }; onProgress?: (progress: MediaProgress) => void } = {},
): Promise<AssembledMedia> {
  const parts: Uint8Array[] = [];
  let offset: number | null = 0;
  let loaded = 0;
  let first: MediaChunkOutput | null = null;
  while (offset !== null) {
    if (options.signal?.aborted) throw new Error("Media loading was cancelled");
    const chunk: MediaChunkOutput = await fetchChunk({ offset, length: MEDIA_REQUEST_BYTES });
    if (options.signal?.aborted) throw new Error("Media loading was cancelled");
    first ??= chunk;
    if (chunk.size !== first.size || chunk.mimeType !== first.mimeType) throw new Error("The media metadata changed while loading. Try again.");
    if (chunk.revision !== first.revision) throw new Error("The media changed while loading. Try again.");
    if (chunk.offset !== offset) throw new Error(`Media chunk offset mismatch: expected ${offset}, got ${chunk.offset}`);
    if (chunk.size > MAX_PLAYABLE_BYTES) throw new Error(`Media too large to play in the app (${chunk.size} bytes)`);
    const bytes = decodeBase64(chunk.data);
    if (bytes.length > MEDIA_REQUEST_BYTES || offset + bytes.length > chunk.size) throw new Error("Media chunk exceeds its declared range");
    if (chunk.nextOffset !== null && (bytes.length === 0 || chunk.nextOffset !== offset + bytes.length)) {
      throw new Error(`Media chunk at ${offset} returned ${bytes.length} bytes but points to ${chunk.nextOffset}`);
    }
    if (chunk.nextOffset === null && offset + bytes.length !== chunk.size) {
      throw new Error(`Media ended at ${offset + bytes.length} of ${chunk.size} bytes`);
    }
    parts.push(bytes);
    loaded += bytes.length;
    options.onProgress?.({ loaded, size: chunk.size });
    offset = chunk.nextOffset;
  }
  if (!first) throw new Error("Media returned no chunks");
  return { mimeType: first.mimeType, revision: first.revision, parts, size: loaded };
}
