import { Readable } from "node:stream";
import { createInflate } from "node:zlib";
import { ERROR_MESSAGES } from "../shared/errors";
import type { Rgba } from "./raster";

export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// decodePngScaled holds a column map and two rows of the source width. The area cap does not bound
// one row: a 69-byte file claiming 300,000,000 x 1 reserved gigabytes before reading a pixel.
const MAX_ROW_STATE_BYTES = 64 * 1024 * 1024;
const damaged = (detail: string) => new Error(ERROR_MESSAGES.imageDamaged("PNG", detail));

export function pngHeader(bytes: Buffer): PngHeader {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw damaged("missing header");
  }
  const header = {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    interlaced: bytes[28] === 1,
  };
  if (!CHANNELS[header.colorType] || ![1, 2, 4, 8, 16].includes(header.bitDepth)) throw damaged("unsupported pixel format");
  return header;
}

interface Chunks {
  palette?: Buffer;
  transparency?: Buffer;
  data: Buffer[];
}

function chunks(bytes: Buffer): Chunks {
  const found: Chunks = { data: [] };
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length));
    if (type === "PLTE") found.palette = body;
    else if (type === "tRNS") found.transparency = body;
    else if (type === "IDAT") found.data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (found.data.length === 0) throw damaged("no image data");
  return found;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(filter: number, row: Uint8Array, previous: Uint8Array, bpp: number): void {
  const length = row.length;
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
      return;
    case 2:
      for (let i = 0; i < length; i++) row[i] = (row[i] + previous[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < length; i++) row[i] = (row[i] + (((i >= bpp ? row[i - bpp] : 0) + previous[i]) >> 1)) & 0xff;
      return;
    case 4:
      for (let i = 0; i < length; i++) {
        row[i] = (row[i] + paeth(i >= bpp ? row[i - bpp] : 0, previous[i], i >= bpp ? previous[i - bpp] : 0)) & 0xff;
      }
      return;
    default:
      throw damaged("bad row filter");
  }
}

function pixelReader(header: PngHeader, found: Chunks): (row: Uint8Array, x: number, out: Float64Array, at: number) => void {
  const { bitDepth, colorType } = header;
  const channels = CHANNELS[colorType];
  const sample =
    bitDepth === 16
      ? (row: Uint8Array, index: number) => row[index * 2]
      : bitDepth === 8
        ? (row: Uint8Array, index: number) => row[index]
        : (row: Uint8Array, index: number) => {
            const bit = index * bitDepth;
            const value = (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
            return colorType === 3 ? value : Math.round((value * 255) / ((1 << bitDepth) - 1));
          };
  const raw16 = (row: Uint8Array, index: number) => (row[index * 2] << 8) | row[index * 2 + 1];
  const trns = found.transparency;
  const keyed = (row: Uint8Array, x: number, channel: number, key: number) =>
    bitDepth === 16 ? raw16(row, x * channels + channel) === key : (bitDepth < 8 ? rawLow(row, x) : row[x * channels + channel]) === key;
  const rawLow = (row: Uint8Array, x: number) => {
    const bit = x * bitDepth;
    return (row[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
  };
  return (row, x, out, at) => {
    let r: number, g: number, b: number, a = 255;
    if (colorType === 3) {
      const index = sample(row, x);
      const palette = found.palette;
      if (!palette || index * 3 + 2 >= palette.length) throw damaged("palette index out of range");
      r = palette[index * 3];
      g = palette[index * 3 + 1];
      b = palette[index * 3 + 2];
      if (trns && index < trns.length) a = trns[index];
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = sample(row, x * channels);
      if (colorType === 4) a = sample(row, x * channels + 1);
      else if (trns && trns.length >= 2 && keyed(row, x, 0, trns.readUInt16BE(0))) a = 0;
    } else {
      r = sample(row, x * channels);
      g = sample(row, x * channels + 1);
      b = sample(row, x * channels + 2);
      if (colorType === 6) a = sample(row, x * channels + 3);
      else if (
        trns &&
        trns.length >= 6 &&
        keyed(row, x, 0, trns.readUInt16BE(0)) &&
        keyed(row, x, 1, trns.readUInt16BE(2)) &&
        keyed(row, x, 2, trns.readUInt16BE(4))
      ) {
        a = 0;
      }
    }
    out[at] += r;
    out[at + 1] += g;
    out[at + 2] += b;
    out[at + 3] += a;
  };
}

function spans(source: number, target: number): Int32Array {
  const edges = new Int32Array(target + 1);
  for (let i = 0; i <= target; i++) edges[i] = Math.floor((i * source) / target);
  for (let i = 1; i <= target; i++) if (edges[i] <= edges[i - 1]) edges[i] = Math.min(source, edges[i - 1] + 1);
  return edges;
}

export async function decodePngScaled(bytes: Buffer, header: PngHeader, width: number, height: number): Promise<Rgba> {
  const found = chunks(bytes);
  const channels = CHANNELS[header.colorType];
  const bpp = Math.max(1, (channels * header.bitDepth) >> 3);
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  if (header.width * Int32Array.BYTES_PER_ELEMENT + 2 * rowBytes > MAX_ROW_STATE_BYTES) {
    throw new Error(ERROR_MESSAGES.imageTooLarge(header.width, header.height));
  }
  const read = pixelReader(header, found);
  const xs = spans(header.width, width);
  const ys = spans(header.height, height);
  const columnOf = new Int32Array(header.width);
  for (let x = 0; x < width; x++) for (let sx = xs[x]; sx < xs[x + 1]; sx++) columnOf[sx] = x;
  const output = new Uint8Array(width * height * 4);
  const sums = new Float64Array(width * 4);
  const counts = new Float64Array(width);
  let previous = new Uint8Array(rowBytes);
  let current = new Uint8Array(rowBytes);
  let filled = -1;
  let y = 0;
  let target = 0;
  const finishRow = () => {
    for (let x = 0; x < header.width; x++) {
      read(current, x, sums, columnOf[x] * 4);
      counts[columnOf[x]]++;
    }
    y++;
    if (y === ys[target + 1]) {
      const out = target * width * 4;
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) output[out + x * 4 + c] = Math.round(sums[x * 4 + c] / counts[x]);
      }
      sums.fill(0);
      counts.fill(0);
      target++;
    }
  };
  let filter = 0;
  const inflate = createInflate();
  Readable.from(found.data).pipe(inflate);
  try {
    for await (const chunk of inflate as AsyncIterable<Buffer>) {
      for (let i = 0; i < chunk.length && y < header.height; ) {
        if (filled < 0) {
          filter = chunk[i++];
          filled = 0;
          continue;
        }
        const take = Math.min(rowBytes - filled, chunk.length - i);
        current.set(chunk.subarray(i, i + take), filled);
        filled += take;
        i += take;
        if (filled === rowBytes) {
          unfilter(filter, current, previous, bpp);
          finishRow();
          [previous, current] = [current, previous];
          filled = -1;
        }
      }
      if (y >= header.height) break;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[doc:")) throw error;
    throw damaged("corrupt image data");
  } finally {
    inflate.destroy();
  }
  if (y < header.height) throw damaged("truncated image data");
  return { width, height, data: output };
}
