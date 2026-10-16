import { PNG } from "pngjs";
import UTIF from "utif2";
import { MAX_RENDER_EDGE_PX, MAX_RESPONSE_BYTES } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface EncodedImage {
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  data: string;
}

export interface Fit {
  maxWidth: number;
  maxBytes: number;
}

const RESPONSE_OVERHEAD_BYTES = 64 * 1024;
const MAX_DECODE_PIXELS = 40_000_000;
export const MAX_STREAMED_PIXELS = 300_000_000;
const REQUEST_PIXEL_BUDGET = 100_000_000;
const REQUEST_TIME_BUDGET_MS = 10_000;
const MAX_FIT_ATTEMPTS = 8;

export const IMAGE_BUDGET_BYTES = base64Capacity(MAX_RESPONSE_BYTES - RESPONSE_OVERHEAD_BYTES);

export function base64Capacity(encodedBytes: number): number {
  return Math.floor(encodedBytes / 4) * 3;
}

export function assertDecodable(width: number, height: number, limit = MAX_DECODE_PIXELS): void {
  if (width * height > limit) {
    throw new Error(ERROR_MESSAGES.imageTooLarge(width, height));
  }
}

export interface DecodeBudget {
  pixels: number;
  deadline: number;
}

export function decodeBudget(): DecodeBudget {
  return { pixels: REQUEST_PIXEL_BUDGET, deadline: Date.now() + REQUEST_TIME_BUDGET_MS };
}

export function spend(budget: DecodeBudget, pixels: number): boolean {
  if (Date.now() > budget.deadline || pixels > budget.pixels) return false;
  budget.pixels -= pixels;
  return true;
}

function edgeScale(width: number, height: number, maxWidth: number): number {
  return Math.min(maxWidth / width, MAX_RENDER_EDGE_PX / Math.max(width, height));
}

export function targetScale(width: number, height: number, maxWidth: number): number {
  return Math.min(1, edgeScale(width, height, maxWidth));
}

export function decodePngBytes(bytes: Uint8Array): Rgba {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { width: png.width, height: png.height, data: png.data };
}

interface JpegParser {
  width: number;
  height: number;
  parse(data: Uint8Array): void;
  getData(options: { width: number; height: number; forceRGB: boolean; isSourcePDF: boolean }): Uint8Array;
}

export function decodeJpegBytes(bytes: Uint8Array): Rgba {
  const Decoder = (UTIF as unknown as { JpegDecoder: new () => JpegParser }).JpegDecoder;
  const parser = new Decoder();
  parser.parse(bytes);
  const { width, height } = parser;
  assertDecodable(width, height);
  const source = parser.getData({ width, height, forceRGB: true, isSourcePDF: false });
  const channels = source.length / (width * height);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; o < data.length; i += channels, o += 4) {
    if (channels === 4) {
      const k = 255 - source[i + 3];
      data[o] = ((255 - source[i]) * k) / 255;
      data[o + 1] = ((255 - source[i + 1]) * k) / 255;
      data[o + 2] = ((255 - source[i + 2]) * k) / 255;
    } else {
      data[o] = source[i];
      data[o + 1] = source[i + 1];
      data[o + 2] = source[i + 2];
    }
    data[o + 3] = 255;
  }
  return { width, height, data };
}

function spans(source: number, target: number): Int32Array {
  const edges = new Int32Array(target + 1);
  for (let i = 0; i <= target; i++) edges[i] = Math.floor((i * source) / target);
  for (let i = 1; i <= target; i++) if (edges[i] <= edges[i - 1]) edges[i] = Math.min(source, edges[i - 1] + 1);
  return edges;
}

export function resize(image: Rgba, width: number, height: number): Rgba {
  if (width === image.width && height === image.height) return image;
  const xs = spans(image.width, width);
  const ys = spans(image.height, height);
  const data = new Uint8Array(width * height * 4);
  const sums = new Float64Array(width * 4);
  const counts = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    sums.fill(0);
    counts.fill(0);
    for (let sy = ys[y]; sy < ys[y + 1]; sy++) {
      const row = sy * image.width * 4;
      for (let x = 0; x < width; x++) {
        for (let sx = xs[x]; sx < xs[x + 1]; sx++) {
          const s = row + sx * 4;
          sums[x * 4] += image.data[s];
          sums[x * 4 + 1] += image.data[s + 1];
          sums[x * 4 + 2] += image.data[s + 2];
          sums[x * 4 + 3] += image.data[s + 3];
          counts[x]++;
        }
      }
    }
    const out = y * width * 4;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) data[out + x * 4 + c] = Math.round(sums[x * 4 + c] / counts[x]);
    }
  }
  return { width, height, data };
}

export function orient(image: Rgba, orientation: number): Rgba {
  const { width, height } = image;
  const swapped = orientation >= 5;
  const outWidth = swapped ? height : width;
  const outHeight = swapped ? width : height;
  const data = new Uint8Array(image.data.length);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sx = x;
      let sy = y;
      switch (orientation) {
        case 2: sx = width - 1 - x; break;
        case 3: sx = width - 1 - x; sy = height - 1 - y; break;
        case 4: sy = height - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = height - 1 - x; break;
        case 7: sx = width - 1 - y; sy = height - 1 - x; break;
        case 8: sx = width - 1 - y; sy = x; break;
      }
      const from = (sy * width + sx) * 4;
      const to = (y * outWidth + x) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = image.data[from + 3];
    }
  }
  return { width: outWidth, height: outHeight, data };
}

function isOpaque(image: Rgba): boolean {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) return false;
  return true;
}

export function encodePng(image: Rgba): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, { colorType: isOpaque(image) ? 2 : 6, deflateLevel: 6 });
}

export function encoded(mimeType: EncodedImage["mimeType"], width: number, height: number, bytes: Uint8Array): EncodedImage {
  return { mimeType, width, height, data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") };
}

export function fitRgba(image: Rgba, fit: Fit): EncodedImage {
  let scale = targetScale(image.width, image.height, fit.maxWidth);
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt++) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const png = encodePng(resize(image, width, height));
    if (png.length <= fit.maxBytes) return encoded("image/png", width, height, png);
    scale *= Math.sqrt(fit.maxBytes / png.length) * 0.9;
  }
  throw new Error(ERROR_MESSAGES.tooLargeForBudget("Image"));
}

export async function fitRendered(
  size: { width: number; height: number },
  render: (width: number, height: number) => Promise<Rgba>,
  fit: Fit,
): Promise<EncodedImage> {
  let scale = edgeScale(size.width, size.height, fit.maxWidth);
  for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt++) {
    const width = Math.max(1, Math.floor(size.width * scale));
    const height = Math.max(1, Math.floor(size.height * scale));
    const png = encodePng(await render(width, height));
    if (png.length <= fit.maxBytes) return encoded("image/png", width, height, png);
    scale *= Math.sqrt(fit.maxBytes / png.length) * 0.9;
  }
  throw new Error(ERROR_MESSAGES.tooLargeForBudget("Page"));
}
