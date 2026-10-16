import { ERROR_MESSAGES } from "../shared/errors";
import { assertDecodable, type Rgba } from "./raster";

const damaged = (detail: string) => new Error(ERROR_MESSAGES.imageDamaged("GIF", detail));
const MAX_CODE_BITS = 12;

export function gifSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 13) throw damaged("missing header");
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function subBlocks(bytes: Buffer, at: number): { data: Buffer; end: number } {
  const parts: Buffer[] = [];
  while (at < bytes.length) {
    const length = bytes[at++];
    if (length === 0) return { data: Buffer.concat(parts), end: at };
    parts.push(bytes.subarray(at, at + length));
    at += length;
  }
  throw damaged("truncated data");
}

function lzw(data: Buffer, minimumBits: number, count: number): Uint8Array {
  if (minimumBits < 2 || minimumBits > 8) throw damaged("bad code size");
  const clear = 1 << minimumBits;
  const end = clear + 1;
  const prefix = new Int32Array(1 << MAX_CODE_BITS);
  const suffix = new Uint8Array(1 << MAX_CODE_BITS);
  const first = new Uint8Array(1 << MAX_CODE_BITS);
  const stack = new Uint8Array(1 << MAX_CODE_BITS);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  const output = new Uint8Array(count);
  let written = 0;
  let size = minimumBits + 1;
  let next = end + 1;
  let previous = -1;
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < data.length && written < count; ) {
    while (bits < size && i < data.length) {
      buffer |= data[i++] << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = buffer & ((1 << size) - 1);
    buffer >>>= size;
    bits -= size;
    if (code === clear) {
      size = minimumBits + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    let current = code;
    let depth = 0;
    if (code >= next) {
      if (previous < 0 || code > next) throw damaged("bad LZW code");
      stack[depth++] = first[previous];
      current = previous;
    } else if (previous < 0 && code >= clear) {
      throw damaged("bad LZW code");
    }
    while (current >= clear) {
      stack[depth++] = suffix[current];
      current = prefix[current];
    }
    stack[depth++] = current;
    while (depth > 0 && written < count) output[written++] = stack[--depth];
    if (previous >= 0 && next < 1 << MAX_CODE_BITS) {
      prefix[next] = previous;
      suffix[next] = current;
      first[next] = first[previous];
      next++;
      if (next === 1 << size && size < MAX_CODE_BITS) size++;
    }
    previous = code;
    first[code] = current;
  }
  return output;
}

function interlacedRows(height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < height; y += step) rows.push(y);
  return rows;
}

export function decodeGif(bytes: Buffer): Rgba {
  const { width, height } = gifSize(bytes);
  assertDecodable(width, height);
  const flags = bytes[10];
  let at = 13;
  let globalPalette: Buffer | null = null;
  if (flags & 0x80) {
    const length = 3 * (1 << ((flags & 7) + 1));
    globalPalette = bytes.subarray(at, at + length);
    at += length;
  }
  let transparent = -1;
  while (at < bytes.length) {
    const marker = bytes[at++];
    if (marker === 0x21) {
      const label = bytes[at++];
      const block = subBlocks(bytes, at);
      if (label === 0xf9 && block.data.length >= 4 && block.data[0] & 1) transparent = block.data[3];
      at = block.end;
      continue;
    }
    if (marker !== 0x2c) break;
    if (at + 9 > bytes.length) throw damaged("truncated image descriptor");
    const left = bytes.readUInt16LE(at);
    const top = bytes.readUInt16LE(at + 2);
    const frameWidth = bytes.readUInt16LE(at + 4);
    const frameHeight = bytes.readUInt16LE(at + 6);
    const frameFlags = bytes[at + 8];
    at += 9;
    assertDecodable(frameWidth, frameHeight);
    let palette = globalPalette;
    if (frameFlags & 0x80) {
      const length = 3 * (1 << ((frameFlags & 7) + 1));
      palette = bytes.subarray(at, at + length);
      at += length;
    }
    if (!palette) throw damaged("no color table");
    const minimumBits = bytes[at++];
    const indices = lzw(subBlocks(bytes, at).data, minimumBits, frameWidth * frameHeight);
    const rows = frameFlags & 0x40 ? interlacedRows(frameHeight) : null;
    const data = new Uint8Array(width * height * 4);
    for (let row = 0; row < frameHeight; row++) {
      const y = top + (rows ? rows[row] : row);
      if (y >= height) continue;
      for (let column = 0; column < frameWidth; column++) {
        const x = left + column;
        const index = indices[row * frameWidth + column];
        if (x >= width || index === transparent || index * 3 + 2 >= palette.length) continue;
        const out = (y * width + x) * 4;
        data[out] = palette[index * 3];
        data[out + 1] = palette[index * 3 + 1];
        data[out + 2] = palette[index * 3 + 2];
        data[out + 3] = 255;
      }
    }
    return { width, height, data };
  }
  throw damaged("no image frame");
}
