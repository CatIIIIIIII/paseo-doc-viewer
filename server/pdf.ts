import { readFile } from "node:fs/promises";
import { PDFiumLibrary, type PDFiumDocument, type PDFiumPage } from "@hyzyla/pdfium/inline";
import { fitRendered, type EncodedImage, type Fit } from "./raster";
import { ERROR_MESSAGES } from "../shared/errors";
import { PDF_MAX_TEXT_CHARS } from "../shared/limits";

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

export function readPdfPageText(file: PdfFile, index: number): Promise<{ pageCount: number; text: string; truncated: boolean }> {
  return withPage(file, index, async (page, pageCount) => ({ pageCount, ...capText(page.getText().replace(/\r\n?/g, "\n")) }));
}
