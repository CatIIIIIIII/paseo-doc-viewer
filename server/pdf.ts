import { readFile } from "node:fs/promises";
import { fitRendered, type EncodedImage, type Fit } from "./raster";
import { PdfiumLoadError, pdfium, pdfiumGeneration } from "./pdfium";
import { ERROR_MESSAGES } from "../shared/errors";
import { PDF_MAX_TEXT_CHARS } from "../shared/limits";
import { literalPattern, type SearchBox } from "../shared/search";

export { PDFIUM_IDLE_MS } from "./pdfium";

export interface PdfFile {
  path: string;
  revision: string;
  size: number;
  password?: string;
  passwordKey: string;
}

interface Held {
  handle: string;
  path: string;
  revision: string;
  bytes: number;
  opened: Promise<{ pageCount: number; generation: number }>;
  // The worker generation that holds the document, once the open succeeded.
  settled?: number;
  users: number;
  evicted: boolean;
}

const MAX_HELD_DOCUMENTS = 4;
const MAX_HELD_BYTES = 256 * 1024 * 1024;
const FPDF_ERR_PASSWORD = 4;
const FPDF_ERR_SECURITY = 5;

const held = new Map<string, Held>();
let serial = 0;

function loadError(error: unknown, withPassword: boolean): unknown {
  if (!(error instanceof PdfiumLoadError)) return error;
  if (error.certificate) return new Error(ERROR_MESSAGES.pdfCertificateSecurity());
  if (error.code === FPDF_ERR_PASSWORD) return new Error(withPassword ? ERROR_MESSAGES.pdfPasswordIncorrect() : ERROR_MESSAGES.pdfPasswordRequired());
  if (error.code === FPDF_ERR_SECURITY) return new Error(ERROR_MESSAGES.pdfUnsupportedSecurity());
  console.error("[doc-viewer] PDF load failed:", error.message);
  return new Error(ERROR_MESSAGES.pdfDamaged());
}

async function load(file: PdfFile, handle: string, signal: AbortSignal | undefined): Promise<{ pageCount: number; generation: number }> {
  const bytes = await readFile(file.path);
  try {
    return await pdfium({ op: "open", key: handle, bytes, password: file.password }, { signal });
  } catch (error) {
    throw loadError(error, Boolean(file.password));
  }
}

function release(entry: Held): void {
  if (!entry.evicted || entry.users > 0) return;
  entry.opened
    .then(({ generation }) => (generation === pdfiumGeneration() ? pdfium({ op: "close", key: entry.handle }) : null), () => {})
    .catch(() => {});
}

// A restarted or recycled worker no longer holds the documents it opened. Opens still pending
// fail with their worker, which evicts the entry.
const stale = (entry: Held) => entry.settled !== undefined && entry.settled !== pdfiumGeneration();

function evict(key: string, entry: Held): void {
  if (held.get(key) !== entry) return;
  held.delete(key);
  entry.evicted = true;
  release(entry);
}

function trim(keep: string): void {
  let total = 0;
  for (const entry of held.values()) total += entry.bytes;
  for (const [key, entry] of held) {
    if (total <= MAX_HELD_BYTES && held.size <= MAX_HELD_DOCUMENTS) return;
    if (key === keep) continue;
    total -= entry.bytes;
    evict(key, entry);
  }
}

async function withTransientDocument<T>(file: PdfFile, signal: AbortSignal | undefined, use: (handle: string, pageCount: number) => Promise<T>): Promise<T> {
  const handle = String(++serial);
  const { pageCount, generation } = await load(file, handle, signal);
  try {
    return await use(handle, pageCount);
  } finally {
    if (generation === pdfiumGeneration()) pdfium({ op: "close", key: handle }).catch(() => {});
  }
}

async function withDocument<T>(file: PdfFile, signal: AbortSignal | undefined, use: (handle: string, pageCount: number) => Promise<T>, { hold = true } = {}): Promise<T> {
  const key = `${file.path}\0${file.revision}\0${file.passwordKey}`;
  let entry = held.get(key);
  if (entry && stale(entry)) {
    held.delete(key);
    entry = undefined;
  }
  if (!entry && !hold) return withTransientDocument(file, signal, use);
  if (entry) {
    if (hold) {
      held.delete(key);
      held.set(key, entry);
    }
  } else {
    for (const [other, candidate] of held) {
      if (candidate.path === file.path && candidate.revision !== file.revision) evict(other, candidate);
    }
    const handle = String(++serial);
    const created: Held = {
      handle,
      path: file.path,
      revision: file.revision,
      bytes: file.size,
      opened: load(file, handle, signal),
      users: 0,
      evicted: false,
    };
    created.opened.then(
      ({ generation }) => (created.settled = generation),
      () => evict(key, created),
    );
    held.set(key, created);
    trim(key);
    entry = created;
  }
  entry.users++;
  try {
    return await use(entry.handle, (await entry.opened).pageCount);
  } finally {
    entry.users--;
    release(entry);
  }
}

export function pdfPageCount(file: PdfFile, signal?: AbortSignal): Promise<number> {
  return withDocument(file, signal, async (_, pageCount) => pageCount);
}

function withPage<T>(file: PdfFile, index: number, signal: AbortSignal | undefined, use: (handle: string, pageCount: number) => Promise<T>, options?: { hold?: boolean }): Promise<T> {
  return withDocument(file, signal, async (handle, pageCount) => {
    if (index >= pageCount) throw new Error(ERROR_MESSAGES.outOfRange("Page", index, pageCount));
    return use(handle, pageCount);
  }, options);
}

export function renderPdfPage(file: PdfFile, index: number, fit: Fit, signal?: AbortSignal, options?: { hold?: boolean }): Promise<{ pageCount: number; image: EncodedImage }> {
  return withPage(file, index, signal, async (key, pageCount) => {
    const size = await pdfium({ op: "size", key, index }, { signal });
    const image = await fitRendered(
      size,
      async (width, height) => ({ width, height, data: (await pdfium({ op: "render", key, index, width, height }, { signal })).data }),
      fit,
    );
    return { pageCount, image };
  }, options);
}

function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= PDF_MAX_TEXT_CHARS) return { text, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(text[PDF_MAX_TEXT_CHARS - 1]!) ? PDF_MAX_TEXT_CHARS - 1 : PDF_MAX_TEXT_CHARS;
  return { text: text.slice(0, end), truncated: true };
}

function normalizeBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function readPdfPageText(file: PdfFile, index: number, signal?: AbortSignal): Promise<{ pageCount: number; text: string; truncated: boolean }> {
  return withPage(file, index, signal, async (key, pageCount) => {
    const { text } = await pdfium({ op: "text", key, index }, { signal });
    return { pageCount, ...capText(normalizeBreaks(text)) };
  });
}

// Normalizes line breaks like readPdfPageText and keeps the raw index of every normalized
// character, so a match found in normalized text maps back to PDFium character indices.
function normalizeWithMap(raw: string): { text: string; rawIndex: number[] } {
  let text = "";
  const rawIndex: number[] = [];
  let index = 0;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (code === 13 && raw.charCodeAt(index + 1) === 10) {
      index++;
      continue;
    }
    rawIndex.push(index);
    text += code === 13 ? "\n" : raw[index];
    index++;
  }
  return { text, rawIndex };
}

export interface PdfPageMatch {
  start: number;
  count: number;
  snippet: string;
  boxes: SearchBox[];
}

// Searches one page with the same pattern as the other kinds, then locates each match on the page.
// Match start/count use the normalized text the text RPC shows; boxes use raw character indices.
export function searchPdfPage(
  file: PdfFile,
  index: number,
  query: string,
  signal?: AbortSignal,
): Promise<{ pageCount: number; truncated: boolean; matches: PdfPageMatch[] }> {
  return withPage(file, index, signal, async (key, pageCount) => {
    const capped = capText((await pdfium({ op: "text", key, index }, { signal })).text);
    const { text, rawIndex } = normalizeWithMap(capped.text);
    const pattern = literalPattern(query);
    const matches: PdfPageMatch[] = [];
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      matches.push({
        start: match.index,
        count: match[0].length,
        snippet: text.slice(Math.max(0, match.index - 45), match.index + match[0].length + 65),
        boxes: [],
      });
    }
    if (matches.length === 0) return { pageCount, truncated: capped.truncated, matches };
    const ranges = matches.map((match): [number, number] => {
      const rawStart = rawIndex[match.start]!;
      const rawEnd = match.start + match.count < rawIndex.length ? rawIndex[match.start + match.count]! : capped.text.length;
      return [rawStart, rawEnd - rawStart];
    });
    const { boxes } = await pdfium({ op: "boxes", key, index, ranges }, { signal });
    matches.forEach((match, i) => (match.boxes = boxes[i] ?? []));
    return { pageCount, truncated: capped.truncated, matches };
  });
}
