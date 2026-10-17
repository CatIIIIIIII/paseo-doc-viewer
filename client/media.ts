import type { MediaChunkOutput } from "../shared/rpc";

export const MEDIA_REQUEST_BYTES = 2 * 1024 * 1024;
export const NATIVE_MEDIA_REQUEST_BYTES = 256 * 1024;
export const MAX_PLAYABLE_BYTES = 256 * 1024 * 1024;
// On phones the host's playAudio takes the whole file as one base64 string, so keep it smaller.
export const NATIVE_AUDIO_MAX_BYTES = 32 * 1024 * 1024;

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

export interface MediaLoadOptions {
  signal?: { aborted: boolean };
  expectedRevision?: string;
  maxBytes?: number;
  chunkBytes?: number;
  onProgress?: (progress: MediaProgress) => void;
}

export const yieldToUI = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function checkCancelled(signal?: { aborted: boolean }): void {
  if (signal?.aborted) throw new Error("Media loading was cancelled");
}

export async function loadMedia(
  fetchChunk: (request: { offset: number; length: number }) => Promise<MediaChunkOutput>,
  options: MediaLoadOptions = {},
): Promise<AssembledMedia> {
  const parts: Uint8Array[] = [];
  let offset: number | null = 0;
  let loaded = 0;
  let first: MediaChunkOutput | null = null;
  while (offset !== null) {
    checkCancelled(options.signal);
    const chunk: MediaChunkOutput = await fetchChunk({ offset, length: options.chunkBytes ?? MEDIA_REQUEST_BYTES });
    checkCancelled(options.signal);
    first ??= chunk;
    if (chunk.size !== first.size || chunk.mimeType !== first.mimeType) throw new Error("The media metadata changed while loading. Try again.");
    if (chunk.revision !== first.revision) throw new Error("The media changed while loading. Try again.");
    if (options.expectedRevision !== undefined && chunk.revision !== options.expectedRevision) throw new Error("The media changed while loading. Try again.");
    if (chunk.offset !== offset) throw new Error(`Media chunk offset mismatch: expected ${offset}, got ${chunk.offset}`);
    if (chunk.size > (options.maxBytes ?? MAX_PLAYABLE_BYTES)) throw new Error(`Media too large to play in this client (${chunk.size} bytes)`);
    const bytes = decodeBase64(chunk.data);
    if (bytes.length > (options.chunkBytes ?? MEDIA_REQUEST_BYTES) || offset + bytes.length > chunk.size) throw new Error("Media chunk exceeds its declared range");
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
    // Give progress, cancellation and navigation a turn between chunks, even on a fast local host.
    await yieldToUI();
  }
  checkCancelled(options.signal);
  if (!first) throw new Error("Media returned no chunks");
  return { mimeType: first.mimeType, revision: first.revision, parts, size: loaded };
}

export type HostPlayAudio = (source: { base64: string; mimeType: string }) => Promise<void>;

// Encode aligned blocks so a large native file never monopolizes the UI thread.
export async function encodeBase64ForPlayback(parts: readonly Uint8Array[], signal?: { aborted: boolean }): Promise<string> {
  const block = new Uint8Array(192 * 1024);
  const encoded: string[] = [];
  let filled = 0;
  for (const part of parts) {
    let offset = 0;
    while (offset < part.length) {
      checkCancelled(signal);
      const length = Math.min(block.length - filled, part.length - offset);
      block.set(part.subarray(offset, offset + length), filled);
      offset += length;
      filled += length;
      if (filled === block.length) {
        encoded.push(encodeBase64([block]));
        filled = 0;
        await yieldToUI();
      }
    }
  }
  checkCancelled(signal);
  if (filled) encoded.push(encodeBase64([block.subarray(0, filled)]));
  return encoded.join("");
}

// Loads the whole file with the usual guarantees, then hands it to the host's player.
export async function playAudioFully(
  fetchChunk: (request: { offset: number; length: number }) => Promise<MediaChunkOutput>,
  playAudio: HostPlayAudio,
  options: MediaLoadOptions & { onPreparing?: () => void; onPlaying?: () => void } = {},
): Promise<AssembledMedia> {
  const media = await loadMedia(fetchChunk, { maxBytes: NATIVE_AUDIO_MAX_BYTES, chunkBytes: NATIVE_MEDIA_REQUEST_BYTES, ...options });
  checkCancelled(options.signal);
  options.onPreparing?.();
  await yieldToUI();
  const base64 = await encodeBase64ForPlayback(media.parts, options.signal);
  checkCancelled(options.signal);
  options.onPlaying?.();
  await playAudio({ base64, mimeType: media.mimeType });
  return media;
}

// The SDK has no appearance flag, so native media controls follow the luminance of the
// theme background. Unknown color formats leave the browser default.
export function colorSchemeFor(background: string): "light" | "dark" | undefined {
  const value = background.trim().toLowerCase();
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(value) ?? /^#([0-9a-f]{3})[0-9a-f]$/.exec(value);
  if (hex) {
    const digits = hex[1]!.length === 3 ? hex[1]!.split("").map((digit) => digit + digit) : hex[1]!.match(/../g)!;
    rgb = digits.map((pair) => parseInt(pair, 16));
  } else {
    const functional = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(value);
    if (functional) rgb = functional.slice(1, 4).map(Number);
  }
  if (!rgb) return undefined;
  const [r, g, b] = rgb.map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "light" : "dark";
}

// The largest box with the media's aspect ratio inside the frame.
export function fittedBox(frame: { width: number; height: number }, ratio: number): { width: number; height: number } {
  if (!(frame.width > 0) || !(frame.height > 0) || !(ratio > 0)) return { width: 0, height: 0 };
  const width = Math.min(frame.width, frame.height * ratio);
  return { width: Math.round(width), height: Math.round(width / ratio) };
}
