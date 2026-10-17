import { readFile } from "node:fs/promises";
import { PDFiumLibrary, type PDFiumDocument, type PDFiumPage } from "@hyzyla/pdfium/inline";
import { fitRendered, type EncodedImage, type Fit } from "./raster";
import { ERROR_MESSAGES } from "../shared/errors";
import { PDF_MAX_TEXT_CHARS } from "../shared/limits";
import { literalPattern, type SearchBox } from "../shared/search";

export interface PdfFile {
  path: string;
  revision: string;
  size: number;
  password?: string;
  passwordKey: string;
}

interface Held {
  path: string;
  revision: string;
  bytes: number;
  document: Promise<PDFiumDocument>;
  users: number;
  evicted: boolean;
}

const MAX_HELD_DOCUMENTS = 4;
const MAX_HELD_BYTES = 256 * 1024 * 1024;
const CERTIFICATE_SECURITY = "/Adobe.PubSec";
export const PDFIUM_IDLE_MS = 60_000;

let library: Promise<PDFiumLibrary> | undefined;
const held = new Map<string, Held>();
let active = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function pdfium(): Promise<PDFiumLibrary> {
  library ??= PDFiumLibrary.init({ disableBase64Warning: true }).catch((error) => {
    library = undefined;
    throw error;
  });
  return library;
}

function loadError(error: unknown, bytes: Buffer, withPassword: boolean): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|security/i.test(message)) {
    if (bytes.includes(CERTIFICATE_SECURITY)) {
      return new Error(ERROR_MESSAGES.pdfCertificateSecurity());
    }
    if (/password/i.test(message)) {
      return new Error(withPassword ? ERROR_MESSAGES.pdfPasswordIncorrect() : ERROR_MESSAGES.pdfPasswordRequired());
    }
    return new Error(ERROR_MESSAGES.pdfUnsupportedSecurity());
  }
  console.error("[doc-viewer] PDF load failed:", error);
  return new Error(ERROR_MESSAGES.pdfDamaged());
}

async function load(path: string, password: string | undefined): Promise<PDFiumDocument> {
  const lib = await pdfium();
  const bytes = await readFile(path);
  try {
    return await lib.loadDocument(bytes, password);
  } catch (error) {
    throw loadError(error, bytes, Boolean(password));
  }
}

function release(entry: Held): void {
  if (entry.evicted && entry.users === 0) entry.document.then((document) => document.destroy(), () => {});
}

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

function recycle(): void {
  const current = library;
  const documents = [...held.values()].map((entry) => entry.document);
  library = undefined;
  held.clear();
  void Promise.allSettled(documents.map((document) => document.then((loaded) => loaded.destroy()))).then(() =>
    current?.then((lib) => lib.destroy(), () => {}),
  );
}

async function withDocument<T>(file: PdfFile, use: (document: PDFiumDocument) => Promise<T>): Promise<T> {
  active++;
  clearTimeout(idleTimer);
  const key = `${file.path}\0${file.revision}\0${file.passwordKey}`;
  let entry = held.get(key);
  if (entry) {
    held.delete(key);
    held.set(key, entry);
  } else {
    for (const [other, candidate] of held) {
      if (candidate.path === file.path && candidate.revision !== file.revision) evict(other, candidate);
    }
    const created: Held = {
      path: file.path,
      revision: file.revision,
      bytes: file.size,
      document: load(file.path, file.password),
      users: 0,
      evicted: false,
    };
    created.document.catch(() => evict(key, created));
    held.set(key, created);
    trim(key);
    entry = created;
  }
  entry.users++;
  try {
    return await use(await entry.document);
  } finally {
    entry.users--;
    release(entry);
    if (--active === 0) {
      idleTimer = setTimeout(recycle, PDFIUM_IDLE_MS);
      // React Native's global typings shadow Node's, so setTimeout is typed as returning a number.
      (idleTimer as unknown as NodeJS.Timeout).unref();
    }
  }
}

export function pdfPageCount(file: PdfFile): Promise<number> {
  return withDocument(file, async (document) => document.getPageCount());
}

function withPage<T>(file: PdfFile, index: number, use: (page: PDFiumPage, pageCount: number) => Promise<T>): Promise<T> {
  return withDocument(file, async (document) => {
    const pageCount = document.getPageCount();
    if (index >= pageCount) throw new Error(ERROR_MESSAGES.outOfRange("Page", index, pageCount));
    const page = document.getPage(index);
    try {
      return await use(page, pageCount);
    } finally {
      page.close();
    }
  });
}

export function renderPdfPage(file: PdfFile, index: number, fit: Fit): Promise<{ pageCount: number; image: EncodedImage }> {
  return withPage(file, index, async (page, pageCount) => {
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const image = await fitRendered(
      { width: originalWidth, height: originalHeight },
      async (width, height) => page.render({ width, height, scale: 1, render: "bitmap", colorSpace: "RGBA" }),
      fit,
    );
    return { pageCount, image };
  });
}

function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= PDF_MAX_TEXT_CHARS) return { text, truncated: false };
  const end = /[\uD800-\uDBFF]/.test(text[PDF_MAX_TEXT_CHARS - 1]!) ? PDF_MAX_TEXT_CHARS - 1 : PDF_MAX_TEXT_CHARS;
  return { text: text.slice(0, end), truncated: true };
}

function normalizeBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function readPdfPageText(file: PdfFile, index: number): Promise<{ pageCount: number; text: string; truncated: boolean }> {
  return withPage(file, index, async (page, pageCount) => ({ pageCount, ...capText(normalizeBreaks(page.getText())) }));
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

// The wrapper keeps the raw PDFium module private; these are the stable wasm exports the search uses.
interface PdfiumTextModule {
  _FPDFText_GetCharBox(textPage: number, index: number, left: number, right: number, bottom: number, top: number): number;
  wasmExports: { malloc(size: number): number; free(ptr: number): void };
  HEAPU8: Uint8Array;
}
type TextPageSource = { loadTextPage(): number };

export interface PdfPageMatch {
  start: number;
  count: number;
  snippet: string;
  boxes: SearchBox[];
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// Merges a match's character boxes into one box per line, normalized to the page (origin top-left).
function matchBoxes(module: PdfiumTextModule, textPage: number, start: number, count: number, width: number, height: number): SearchBox[] {
  if (width <= 0 || height <= 0) return [];
  const ptr = module.wasmExports.malloc(32);
  try {
    const lines: SearchBox[] = [];
    let top = 0;
    let bottom = 0;
    let left = 0;
    let right = 0;
    const flush = () => {
      lines.push({
        x: clamp01(left / width),
        y: clamp01(1 - top / height),
        width: clamp01((right - left) / width),
        height: clamp01((top - bottom) / height),
      });
    };
    let open = false;
    for (let index = start; index < start + count; index++) {
      const view = new Float64Array(module.HEAPU8.buffer, ptr, 4);
      if (!module._FPDFText_GetCharBox(textPage, index, ptr, ptr + 8, ptr + 16, ptr + 24)) continue;
      const [charLeft, charRight, charBottom, charTop] = [view[0]!, view[1]!, view[2]!, view[3]!];
      if (!open || Math.abs(charTop - top) > 1 || Math.abs(charBottom - bottom) > 1) {
        if (open) flush();
        open = true;
        left = charLeft;
        right = charRight;
        bottom = charBottom;
        top = charTop;
      } else {
        left = Math.min(left, charLeft);
        right = Math.max(right, charRight);
      }
    }
    if (open) flush();
    return lines;
  } finally {
    module.wasmExports.free(ptr);
  }
}

// Searches one page with the same pattern as the other kinds, then locates each match on the page.
// Match start/count use the normalized text the text RPC shows; boxes use raw character indices.
export function searchPdfPage(file: PdfFile, index: number, query: string): Promise<{ pageCount: number; truncated: boolean; matches: PdfPageMatch[] }> {
  return withPage(file, index, async (page, pageCount) => {
    const capped = capText(page.getText());
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
    const module = (page as unknown as { module: PdfiumTextModule }).module;
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const textPage = (page as unknown as TextPageSource).loadTextPage();
    for (const match of matches) {
      const rawStart = rawIndex[match.start]!;
      const rawEnd = match.start + match.count < rawIndex.length ? rawIndex[match.start + match.count]! : capped.text.length;
      match.boxes = matchBoxes(module, textPage, rawStart, rawEnd - rawStart, originalWidth, originalHeight);
    }
    return { pageCount, truncated: capped.truncated, matches };
  });
}
